// src/handlers/inbound.js
const { pool } = require("../db");
const { routeIntent, polishReply } = require("../services/llmService");
const { insertWaMessage } = require("../services/messagesService");
const {
  getOpenSessionByPhone,
  createSession,
  lockSession,
  updateSession,
  closeSession,
  closeIfTimedOut,
} = require("../services/sessionsService");

const { notifyAdmin } = require("../services/notifyService");

const contrato = require("./flows/contrato");
const pago = require("./flows/pago");
const falla = require("./flows/falla");
const faq = require("./flows/faq");

// =====================
// Config
// =====================
const SESSION_TIMEOUT_MIN = Number(process.env.SESSION_TIMEOUT_MIN || 20);
const LLM_CONFIDENCE_MIN = Number(process.env.LLM_INTENT_MIN_CONF || 0.7);

// =====================
// Copy / UI
// =====================
function menu(profileName) {
  const name = profileName ? ` ${profileName}` : "";
  return (
    `¡Hola${name}! 👋\n` +
    `Soy del equipo de InterWIFI.\n\n` +
    `¿En qué te ayudo hoy?\n` +
    `1) Contratar internet\n` +
    `2) Reportar una falla\n` +
    `3) Registrar un pago\n` +
    `4) Info (horarios, ubicación, formas de pago)\n\n` +
    `Responde con *1, 2, 3, 4* o escribe tu necesidad 🙂\n\n` +
    `Comandos: *menú*, *inicio*, *cancelar*, *agente*`
  );
}

function greetingWithSession(existing) {
  const flow = String(existing?.flow || "").toUpperCase();
  const label =
    flow === "CONTRATO"
      ? "contratación"
      : flow === "PAGO"
      ? "registro de pago"
      : flow === "FALLA"
      ? "reporte de falla"
      : "información";

  return (
    `¡Hola! 👋\n` +
    `Veo que tienes un proceso abierto de *${label}*.\n` +
    `¿Quieres *continuar* o prefieres ver el *menú*?\n` +
    `Responde: continuar o menú.\n\n` +
    `Tip: escribe *cancelar* para terminar el proceso.`
  );
}

// =====================
// Logging (estructurado)
// =====================
function maskPhone(p) {
  const s = String(p || "");
  if (s.length <= 6) return s;
  return s.slice(0, 3) + "***" + s.slice(-3);
}

function logEvent(evt) {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      app: "interwifi-bot",
      ...evt,
    })
  );
}

// =====================
// Text utils
// =====================
function norm(s) {
  return String(s || "")
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ");
}

function isGreetingOnly(text) {
  const t = norm(text);
  if (!t) return false;

  const hasBusiness =
    /(contrat|internet|pago|pagos|falla|deposit|transfer|plan|paquete|horario|direccion|ubic|ubicacion|precio)/i.test(
      t
    );
  if (hasBusiness) return false;

  return /^(hola|hol|hey|hi|ola|buenas|buenos dias|buen dia|buenas tardes|buenas noches|que tal|q tal|que onda)$/.test(
    t
  );
}

// ✅ menú principal (sinónimos)
function isMenuWord(text) {
  // "menú" e "inicio" SIEMPRE significan "menú principal"
  return /^(menu|menú|inicio|principal|opciones|volver|regresar|home|start)$/i.test(norm(text));
}

function isCancelWord(text) {
  return /^(cancelar|cancel|salir|terminar|anular|cerrar)$/i.test(norm(text));
}

function isAgentWord(text) {
  return /^(agente|asesor|humano|persona|soporte humano|representante|help)$/i.test(norm(text));
}

// ✅ “continuar” explícito (IMPORTANT: NO debe caer al flow como respuesta)
function isContinueWord(text) {
  return /^(continuar|continua|seguir|sigue|dale|ok continuar|listo continuar|continue)$/i.test(
    norm(text)
  );
}

// Menú principal: 1-4
function parseMainMenuChoice(text) {
  const t = norm(text);
  if (t === "1") return "CONTRATO";
  if (t === "2") return "FALLA";
  if (t === "3") return "PAGO";
  if (t === "4") return "FAQ";
  return null;
}

/**
 * Intent fast
 * - FAQ SIEMPRE GANA cuando el texto es claramente info.
 * - PAGO solo si es “registrar pago / comprobante / ya pagué”
 */
function mapIntentFast(text) {
  const t = norm(text);

  // FAQ win
  if (
    /(formas de pago|forma de pago|como pagar|cómo pagar|donde pagar|dónde pagar|metodos de pago|métodos de pago)/i.test(
      t
    )
  )
    return "FAQ";
  if (/(transferencia|deposito|depósito|cuenta|clabe|tarjeta|oxxo|spin|azteca|banco|beneficiario)/i.test(t))
    return "FAQ";
  if (
    /(horario|horarios|ubicacion|ubicación|direccion|dirección|precio|precios|paquete|paquetes|plan|planes|info|informacion|información)/i.test(
      t
    )
  )
    return "FAQ";

  // pago registro
  if (
    /(registrar pago|reportar pago|confirmar pago|ya pague|ya pagué|pague|pagué|adjunto|te envio|te envío|mando|envio comprobante|envío comprobante|comprobante|ticket|captura|recibo)/i.test(
      t
    )
  )
    return "PAGO";

  if (/(contrat|internet|instal|nuevo servicio)/i.test(t)) return "CONTRATO";
  if (/(falla|sin internet|no funciona|intermit|lento)/i.test(t)) return "FALLA";

  // “pago(s)” solo => FAQ
  if (/^pago(s)?$/.test(t)) return "FAQ";

  return null;
}

// ✅ “FAQ override” aunque haya sesión (si el usuario pide INFO en medio de otro flow)
function shouldForceFaqSwitch(text) {
  const t = norm(text);
  return /(formas de pago|forma de pago|como pagar|cómo pagar|metodos de pago|métodos de pago|transferencia|deposito|depósito|cuenta|clabe|tarjeta|oxxo|banco|beneficiario|horario|horarios|ubicacion|ubicación|direccion|dirección|precio|precios|paquete|paquetes|plan|planes|informacion|información|info)/i.test(
    t
  );
}

// ✅ Si estás dentro de FAQ y el usuario ahora quiere una acción (contrato/pago/falla), salimos de FAQ
function shouldExitFaqToFlow(text) {
  const intent = mapIntentFast(text);
  if (intent === "CONTRATO") return "CONTRATO";
  if (intent === "PAGO") return "PAGO";
  if (intent === "FALLA") return "FALLA";
  return null;
}

function getIntro(flow, inbound) {
  if (flow === "CONTRATO") return contrato.intro(inbound.phoneE164);
  if (flow === "PAGO") return pago.intro();
  if (flow === "FALLA") return falla.intro();
  return faq.intro();
}

// =====================
// Main
// =====================
async function handleInbound({ inbound, send }) {
  const inboundText = String(inbound.text || "").trim();
  const providerMsgId = inbound.providerMsgId || null;

  const inserted = await insertWaMessage({
    sessionId: null,
    phoneE164: inbound.phoneE164,
    direction: "IN",
    body: inboundText,
    media: inbound.media,
    raw: inbound.raw,
    providerMsgId,
  });
  if (!inserted) return;

  // =========================
  // Outbound helpers (Enterprise-grade)
  // =========================
  function isOutboundObject(x) {
    return !!x && typeof x === "object" && !Array.isArray(x);
  }

  function normalizeOutbound(out) {
    // string => text
    if (typeof out === "string") {
      const text = String(out || "").trim();
      return { type: "text", text };
    }

    // object => {type,...}
    if (isOutboundObject(out)) {
      const type = String(out.type || "").toLowerCase();

      if (type === "image") {
        const url = String(out.url || out.link || out.imageUrl || "").trim();
        const caption = String(out.caption || "").trim();
        return { type: "image", url, caption };
      }

      if (type === "document") {
        const url = String(out.url || out.link || out.documentUrl || "").trim();
        const caption = String(out.caption || "").trim();
        const filename = String(out.filename || out.fileName || "documento").trim();
        return { type: "document", url, caption, filename };
      }

      // fallback: treat unknown object as text (avoid crashing prod)
      const text = String(out.text || out.message || "").trim();
      return { type: "text", text };
    }

    // null/undefined => noop
    return { type: "noop" };
  }

  /**
   * ✅ Enterprise sender + logger
   * - Supports TEXT + IMAGE (and optional DOC)
   * - polishReply only for TEXT
   * - Inserts message log with correct kind
   * - NEVER sends caption separately (prevents rate-limit hits)
   */
  async function sendAndLog({ sessionId, flow, step, kind, out }) {
    const payload = normalizeOutbound(out);

    // noop
    if (payload.type === "noop") return;

    // -------------------------
    // IMAGE / DOCUMENT (no polish)
    // -------------------------
    if (payload.type === "image" || payload.type === "document") {
      const mediaKind = payload.type;
      const k = kind || `flow_reply_${mediaKind}`;

      // Hard validation (fail safe -> send text fallback)
      if (!payload.url) {
        const fallback = `⚠️ No pude enviar el archivo (URL vacía).`;
        await sendAndLog({
          sessionId,
          flow,
          step,
          kind: "flow_reply_text",
          out: fallback,
        });
        return;
      }

      try {
        await send({
          type: mediaKind,
          url: payload.url,
          caption: payload.caption || "",
          ...(mediaKind === "document" ? { filename: payload.filename } : {}),
        });
      } catch (e) {
        // Log error + fallback text to user (production-safe)
        logEvent({
          event: "send_failed",
          intent: flow,
          step,
          kind: k,
          error: String(e?.message || e),
          phone: maskPhone(inbound.phoneE164),
          provider_msg_id: providerMsgId || null,
        });

        await insertWaMessage({
          sessionId: sessionId || null,
          phoneE164: inbound.phoneE164,
          direction: "OUT",
          body: payload.caption || null,
          raw: {
            kind: k,
            flow,
            step,
            media: { type: mediaKind, url: payload.url },
            error: String(e?.message || e),
          },
        });

        // fallback user text (but short)
        await sendAndLog({
          sessionId,
          flow,
          step,
          kind: "flow_reply_text",
          out: "No pude enviar la imagen 😕 Por favor revisa tus conexiones manualmente y seguimos con las preguntas.",
        });

        return;
      }

      // Persist OUT log
      await insertWaMessage({
        sessionId: sessionId || null,
        phoneE164: inbound.phoneE164,
        direction: "OUT",
        body: payload.caption || null,
        raw: {
          kind: k,
          flow,
          step,
          media: { type: mediaKind, url: payload.url },
        },
      });

      logEvent({
        event: "outgoing_message",
        kind: k,
        intent: flow,
        step,
        session_id: sessionId || null,
        phone: maskPhone(inbound.phoneE164),
        provider_msg_id: providerMsgId || null,
      });

      return;
    }

    // -------------------------
    // TEXT (polish)
    // -------------------------
    let msg = String(payload.text || "").trim();
    if (!msg) return;

    try {
      const polished = await polishReply({
        intent: flow,
        step,
        rawReply: msg,
        userText: inboundText,
        profileName: inbound.profileName || "",
      });
      if (polished) msg = String(polished).trim();
    } catch {}

    try {
      await send(msg);
    } catch (e) {
      logEvent({
        event: "send_failed",
        intent: flow,
        step,
        kind: kind || "flow_reply_text",
        error: String(e?.message || e),
        phone: maskPhone(inbound.phoneE164),
        provider_msg_id: providerMsgId || null,
      });
    }

    await insertWaMessage({
      sessionId: sessionId || null,
      phoneE164: inbound.phoneE164,
      direction: "OUT",
      body: msg || null,
      raw: { kind: kind || "flow_reply_text", flow, step },
    });

    logEvent({
      event: "outgoing_message",
      kind: kind || "flow_reply_text",
      intent: flow,
      step,
      session_id: sessionId || null,
      phone: maskPhone(inbound.phoneE164),
      provider_msg_id: providerMsgId || null,
    });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    let existing = await getOpenSessionByPhone(inbound.phoneE164, client);

    logEvent({
      event: "incoming_message",
      intent: existing?.flow || null,
      step: existing?.step || null,
      session_id: existing?.session_id || null,
      phone: maskPhone(inbound.phoneE164),
      provider_msg_id: providerMsgId || null,
      text: norm(inboundText).slice(0, 140),
    });

    // timeout
    if (existing) {
      const timedOut = await closeIfTimedOut(existing, SESSION_TIMEOUT_MIN, client);
      if (timedOut) existing = null;
    }

    const mainChoice = parseMainMenuChoice(inboundText);

    // =====================
    // NO SESSION
    // =====================
    if (!existing) {
      if (isCancelWord(inboundText)) {
        await client.query("COMMIT");
        await sendAndLog({
          sessionId: null,
          flow: "MENU",
          step: 0,
          kind: "cancel_no_session",
          out: `Listo ✅ No hay ningún proceso activo.\n\n${menu(inbound.profileName)}`,
        });
        return;
      }

      if (isAgentWord(inboundText)) {
        await client.query("COMMIT");
        await notifyAdmin(
          `🧑‍💼 *SOLICITA AGENTE*\n` +
            `Tel: ${inbound.phoneE164}\n` +
            `Nombre: ${inbound.profileName || "N/A"}\n` +
            `Mensaje: ${inboundText || "(sin texto)"}`
        );
        await sendAndLog({
          sessionId: null,
          flow: "MENU",
          step: 0,
          kind: "agent_no_session",
          out: `Listo ✅ Ya avisé a un asesor. En breve te contactamos.\n\n${menu(inbound.profileName)}`,
        });
        return;
      }

      if (mainChoice) {
        const flow = mainChoice;
        const session = await createSession(
          { phoneE164: inbound.phoneE164, flow, step: 1, data: { menu_mode: false } },
          client
        );
        await client.query("COMMIT");
        await sendAndLog({
          sessionId: session.session_id,
          flow,
          step: 1,
          kind: "intro_by_number_no_session",
          out: getIntro(flow, inbound),
        });
        return;
      }

      if (!inboundText || isGreetingOnly(inboundText) || isMenuWord(inboundText)) {
        await client.query("COMMIT");
        await sendAndLog({
          sessionId: null,
          flow: "MENU",
          step: 0,
          kind: "menu_no_session",
          out: menu(inbound.profileName),
        });
        return;
      }

      let flow = mapIntentFast(inboundText);

      if (!flow) {
        const routed = await routeIntent(inboundText);
        const conf = Number(routed?.confidence ?? 0);

        if (!routed?.intent || conf < LLM_CONFIDENCE_MIN) {
          await client.query("COMMIT");
          await sendAndLog({
            sessionId: null,
            flow: "MENU",
            step: 0,
            kind: "menu_low_conf",
            out: `Para ayudarte mejor, elige una opción:\n\n${menu(inbound.profileName)}`,
          });
          return;
        }
        flow = routed.intent;
      }

      const session = await createSession(
        { phoneE164: inbound.phoneE164, flow, step: 1, data: { menu_mode: false } },
        client
      );

      await client.query("COMMIT");
      await sendAndLog({
        sessionId: session.session_id,
        flow,
        step: 1,
        kind: "intro_new_session",
        out: getIntro(flow, inbound),
      });
      return;
    }

    // =====================
    // SESSION EXISTS
    // =====================
    const existingFlow = String(existing.flow || "").toUpperCase();
    const menuMode = Boolean(existing?.data?.menu_mode);
    const isFaqSession = existingFlow === "FAQ";

    // cancel
    if (isCancelWord(inboundText)) {
      await closeSession(existing.session_id, client, "user_cancel");
      await client.query("COMMIT");
      await sendAndLog({
        sessionId: null,
        flow: "MENU",
        step: 0,
        kind: "cancel_reset",
        out: `Listo ✅ Proceso cancelado.\n\n${menu(inbound.profileName)}`,
      });
      return;
    }

    // agent
    if (isAgentWord(inboundText)) {
      await closeSession(existing.session_id, client, "agent_requested");
      await client.query("COMMIT");

      await notifyAdmin(
        `🧑‍💼 *SOLICITA AGENTE*\n` +
          `Tel: ${inbound.phoneE164}\n` +
          `Nombre: ${inbound.profileName || "N/A"}\n` +
          `Proceso: ${existing.flow} (step ${existing.step})\n` +
          `Mensaje: ${inboundText || "(sin texto)"}`
      );

      await sendAndLog({
        sessionId: null,
        flow: "MENU",
        step: 0,
        kind: "agent_requested",
        out: `Listo ✅ Ya avisé a un asesor. En breve te contactamos.\n\n${menu(inbound.profileName)}`,
      });
      return;
    }

    // ✅ FAQ: “menú/inicio” => salir de FAQ y mostrar MENÚ PRINCIPAL (y cerrar FAQ)
    if (isFaqSession && isMenuWord(inboundText)) {
      await closeSession(existing.session_id, client, "faq_exit_to_main_menu");
      await client.query("COMMIT");
      await sendAndLog({
        sessionId: null,
        flow: "MENU",
        step: 0,
        kind: "faq_exit_to_menu",
        out: menu(inbound.profileName),
      });
      return;
    }

    // ✅ FAQ: si el usuario ya quiere una acción (contrato/pago/falla), switch de flow
    if (isFaqSession) {
      const nextFlow = shouldExitFaqToFlow(inboundText);
      if (nextFlow) {
        await closeSession(existing.session_id, client, "faq_switch_flow");
        const newSession = await createSession(
          { phoneE164: inbound.phoneE164, flow: nextFlow, step: 1, data: { menu_mode: false } },
          client
        );
        await client.query("COMMIT");
        await sendAndLog({
          sessionId: newSession.session_id,
          flow: nextFlow,
          step: 1,
          kind: "faq_switch_to_flow_by_text",
          out: getIntro(nextFlow, inbound),
        });
        return;
      }
    }

    // ✅ Menú principal con sesión abierta (NO aplica si estás en FAQ; FAQ ya se manejó arriba)
    if (!isFaqSession && isMenuWord(inboundText)) {
      await updateSession(
        {
          sessionId: existing.session_id,
          step: existing.step,
          data: { ...(existing.data || {}), menu_mode: true, menu_mode_at: Date.now() },
        },
        client
      );

      const label =
        existingFlow === "CONTRATO"
          ? "contratación"
          : existingFlow === "PAGO"
          ? "registro de pago"
          : existingFlow === "FALLA"
          ? "reporte de falla"
          : "información";

      await client.query("COMMIT");
      await sendAndLog({
        sessionId: existing.session_id,
        flow: existing.flow,
        step: existing.step,
        kind: "menu_soft",
        out:
          `📌 Tienes un proceso abierto de *${label}*.\n` +
          `Responde *continuar* para seguir, o elige una opción:\n\n` +
          menu(inbound.profileName),
      });
      return;
    }

    // saludo con sesión: no avances
    if (isGreetingOnly(inboundText)) {
      await client.query("COMMIT");
      await sendAndLog({
        sessionId: existing.session_id,
        flow: existing.flow,
        step: existing.step,
        kind: "greeting_existing_session",
        out: greetingWithSession(existing),
      });
      return;
    }

    // ✅ “continuar”: limpia menu_mode y NO lo pases al flow
    if (isContinueWord(inboundText)) {
      if (menuMode) {
        await updateSession(
          {
            sessionId: existing.session_id,
            step: existing.step,
            data: { ...(existing.data || {}), menu_mode: false },
          },
          client
        );
      }

      await client.query("COMMIT");
      await sendAndLog({
        sessionId: existing.session_id,
        flow: existing.flow,
        step: existing.step,
        kind: "continue_session",
        out: "Listo ✅",
      });
      return;
    }

    // ✅ Si el usuario pide INFO en medio de otro flow: switch a FAQ
    if (!isFaqSession && shouldForceFaqSwitch(inboundText)) {
      await closeSession(existing.session_id, client, "switch_to_faq");
      const newSession = await createSession(
        { phoneE164: inbound.phoneE164, flow: "FAQ", step: 1, data: { menu_mode: false } },
        client
      );
      await client.query("COMMIT");
      await sendAndLog({
        sessionId: newSession.session_id,
        flow: "FAQ",
        step: 1,
        kind: "switch_flow_to_faq_by_text",
        out: getIntro("FAQ", inbound),
      });
      return;
    }

    // ===== números 1-4 =====
    if (mainChoice) {
      if (isFaqSession) {
        // FAQ interpreta 1-4 internamente (horarios/ubicación/pagos/precios)
        await updateSession(
          {
            sessionId: existing.session_id,
            step: existing.step,
            data: { ...(existing.data || {}), menu_mode: false },
          },
          client
        );
        // no return: cae a dispatch FAQ
      } else if (menuMode) {
        // Switch solo si el usuario pidió menú antes
        await closeSession(existing.session_id, client, "switch_flow");
        const newSession = await createSession(
          { phoneE164: inbound.phoneE164, flow: mainChoice, step: 1, data: { menu_mode: false } },
          client
        );
        await client.query("COMMIT");
        await sendAndLog({
          sessionId: newSession.session_id,
          flow: mainChoice,
          step: 1,
          kind: "switch_flow_by_number",
          out: getIntro(mainChoice, inbound),
        });
        return;
      }
      // Si NO hay menu_mode => NO cambies flow
    }

    // si llega texto real, apaga menu_mode (para que no quede pegado)
    if (menuMode) {
      await updateSession(
        {
          sessionId: existing.session_id,
          step: existing.step,
          data: { ...(existing.data || {}), menu_mode: false },
        },
        client
      );
    }

    // =====================
    // lock + dispatch
    // =====================
    const locked = await lockSession(existing.session_id, client);
    if (!locked) {
      await client.query("COMMIT");
      await sendAndLog({
        sessionId: existing.session_id,
        flow: existing.flow,
        step: existing.step,
        kind: "lock_failed",
        out: menu(inbound.profileName),
      });
      return;
    }

    // ✅ PREMIUM BOT CTX: one send() that supports both text & media,
    // plus explicit sendImage() for flows (backwards compatible)
    const ctx = {
      session: locked,
      inbound,

      // send text or object {type:"image", url, caption}
      send: async (out) => {
        const normalized = normalizeOutbound(out);
        const k =
          normalized.type === "image"
            ? "flow_reply_image"
            : normalized.type === "document"
            ? "flow_reply_document"
            : "flow_reply_text";

        await sendAndLog({
          sessionId: locked.session_id,
          flow: locked.flow,
          step: locked.step,
          kind: k,
          out,
        });
      },

      // Explicit helper used by falla.js (and any future flows)
      sendImage: async (url, caption = "") => {
        await sendAndLog({
          sessionId: locked.session_id,
          flow: locked.flow,
          step: locked.step,
          kind: "flow_reply_image",
          out: { type: "image", url, caption },
        });
      },

      updateSession: async ({ step, data }) =>
        updateSession({ sessionId: locked.session_id, step, data }, client),

      closeSession: async () => closeSession(locked.session_id, client, "flow_done"),
    };

    logEvent({
      event: "flow_dispatch",
      intent: locked.flow,
      step: locked.step,
      session_id: locked.session_id,
      phone: maskPhone(inbound.phoneE164),
    });

    if (locked.flow === "CONTRATO") await contrato.handle(ctx);
    else if (locked.flow === "PAGO") await pago.handle(ctx);
    else if (locked.flow === "FALLA") await falla.handle(ctx);
    else await faq.handle(ctx);

    await client.query("COMMIT");
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {}

    logEvent({
      event: "webhook_error",
      error: String(e?.message || e),
      stack: String(e?.stack || "").slice(0, 2000),
      phone: maskPhone(inbound.phoneE164),
      provider_msg_id: providerMsgId || null,
    });

    throw e;
  } finally {
    client.release();
  }
}

module.exports = { handleInbound, menu };