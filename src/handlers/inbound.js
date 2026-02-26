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
    `Comandos: *menú*, *cancelar*, *agente*`
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

function isMenuWord(text) {
  return /^(menu|menú|inicio|opciones|volver|regresar)$/i.test(norm(text));
}

function isCancelWord(text) {
  return /^(cancelar|cancel|salir|terminar|anular|cerrar)$/i.test(norm(text));
}

function isAgentWord(text) {
  return /^(agente|asesor|humano|persona|soporte humano|representante|help)$/i.test(norm(text));
}

// ✅ “continuar” explícito (IMPORTANT: NO debe caer al flow como respuesta)
function isContinueWord(text) {
  return /^(continuar|continua|seguir|sigue|dale|va|ok continuar|listo continuar|continue)$/i.test(
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

// ✅ “FAQ override” aunque haya sesión
function shouldForceFaqSwitch(text) {
  const t = norm(text);
  return /(formas de pago|forma de pago|como pagar|cómo pagar|metodos de pago|métodos de pago|transferencia|deposito|depósito|cuenta|clabe|tarjeta|oxxo|banco|beneficiario|horario|horarios|ubicacion|ubicación|direccion|dirección|precio|precios|paquete|paquetes|plan|planes|informacion|información|info)/i.test(
    t
  );
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

  async function sendAndLog({ sessionId, flow, step, kind, text }) {
    let msg = String(text || "").trim();

    try {
      const out = await polishReply({
        intent: flow,
        step,
        rawReply: msg,
        userText: inboundText,
        profileName: inbound.profileName || "",
      });
      if (out) msg = String(out).trim();
    } catch {}

    try {
      if (msg) await send(msg);
    } catch (e) {
      logEvent({
        event: "send_failed",
        intent: flow,
        step,
        kind,
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
      raw: { kind, flow, step },
    });

    logEvent({
      event: "outgoing_message",
      kind,
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
          text: `Listo ✅ No hay ningún proceso activo.\n\n${menu(inbound.profileName)}`,
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
          text: `Listo ✅ Ya avisé a un asesor. En breve te contactamos.\n\n${menu(inbound.profileName)}`,
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
          text: getIntro(flow, inbound),
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
          text: menu(inbound.profileName),
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
            text: `Para ayudarte mejor, elige una opción:\n\n${menu(inbound.profileName)}`,
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
        text: getIntro(flow, inbound),
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
        text: `Listo ✅ Proceso cancelado.\n\n${menu(inbound.profileName)}`,
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
        text: `Listo ✅ Ya avisé a un asesor. En breve te contactamos.\n\n${menu(inbound.profileName)}`,
      });
      return;
    }

    // ✅ FIX PRINCIPAL: “menú” con sesión abierta -> NO mandes greeting+menú (eso se ve doble/bug)
    if (isMenuWord(inboundText)) {
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
        text:
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
        text: greetingWithSession(existing),
      });
      return;
    }

    // ✅ “continuar”: limpia menu_mode y NO lo pases al flow (para que no se tome como respuesta)
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
        text: "Listo ✅",
      });
      return;
    }

    // ✅ Si el usuario pide INFO (formas de pago/horarios/etc) en medio de otro flow: switch a FAQ
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
        text: getIntro("FAQ", inbound),
      });
      return;
    }

    // ===== números 1-4 =====
    if (mainChoice) {
      if (isFaqSession) {
        // FAQ interpreta 1-4 internamente
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
          text: getIntro(mainChoice, inbound),
        });
        return;
      }
      // Si NO hay menu_mode => NO cambies flow (evita bugs por “1/2/3/4” accidentales)
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
        text: menu(inbound.profileName),
      });
      return;
    }

    const ctx = {
      session: locked,
      inbound,
      send: async (textOut) => {
        await sendAndLog({
          sessionId: locked.session_id,
          flow: locked.flow,
          step: locked.step,
          kind: "flow_reply",
          text: textOut,
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