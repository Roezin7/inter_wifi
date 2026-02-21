// src/handlers/inbound.js
const { pool } = require("../db");

const { routeIntent, polishReply } = require("../services/llmService");
const { insertWaMessage } = require("../services/messagesService");

const {
  getOpenSessionByPhone,
  createSession,
  lockSession,
  updateSession,
  closeSession
} = require("../services/sessionsService");

const contrato = require("./flows/contrato");
const pago = require("./flows/pago");
const falla = require("./flows/falla");
const faq = require("./flows/faq");

// =====================
// Copy / Brand Text
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
    `Responde con 1, 2, 3, 4 o escribe tu necesidad 🙂`
  );
}

function greetingWithSession(existing) {
  const flow = String(existing?.flow || "FAQ").toUpperCase();
  const label =
    flow === "CONTRATO" ? "contratación" :
    flow === "PAGO" ? "registro de pago" :
    flow === "FALLA" ? "reporte de falla" : "información";

  return (
    `¡Hola! 👋\n` +
    `Veo que tienes un proceso abierto de *${label}*.\n` +
    `¿Quieres *continuar* o prefieres ver el *menú*?\n` +
    `Responde: *continuar* o *menú*.`
  );
}

// =====================
// Text utilities
// =====================
function norm(s) {
  return String(s || "")
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s]/gu, "") // quita signos/emoji
    .replace(/\s+/g, " ");
}

function isGreetingOnly(text) {
  const t = norm(text);
  if (!t) return false;

  // si trae intención, NO es saludo-only
  const hasBusiness =
    /(contrat|instal|servicio|internet|plan|paquete|precio|costo|pago|pagu|deposit|transfer|comprobante|ticket|falla|sin internet|no hay internet|lento|intermit|soporte|reporte|ubic|direccion|horario)/i.test(
      t
    );
  if (hasBusiness) return false;

  // saludos
  if (
    /^(hola|hol|hey|hi|hello|ola|buenas|buenos dias|buen dia|buen día|buenas tardes|buenas noches|que tal|qué tal|q tal|que onda|qué onda|q onda)$/.test(
      t
    )
  ) return true;

  // "hola bro" / "hola arturo" / "buenas noches"
  const words = t.split(" ").filter(Boolean);
  if (words.length <= 3) {
    if (["hola","hol","hey","hi","hello","ola","buenas","buenos"].includes(words[0])) return true;
    if (words[0] === "que" || words[0] === "qué") return true;
  }

  return false;
}

function isMenuWord(text) {
  const t = norm(text);
  return /^(menu|menú|inicio|start|opciones|volver|regresar)$/.test(t);
}

function isContinueWord(text) {
  const t = norm(text);
  return /^(continuar|continue|seguir|sigue|dale|va|ok)$/.test(t);
}

function isVeryShort(text) {
  const t = String(text || "").trim();
  return !t || t.length < 3;
}

// =====================
// Routing (determinístico primero)
// =====================
function mapNumberToIntent(text) {
  const t = norm(text);

  if (t === "1") return "CONTRATO";
  if (t === "2") return "FALLA";
  if (t === "3") return "PAGO";
  if (t === "4") return "FAQ";

  if (/(contrat|instal|quiero internet|nuevo servicio)/i.test(t)) return "CONTRATO";
  if (/(falla|sin internet|no hay internet|no tengo internet|intermit|lento|no carga|no funciona)/i.test(t)) return "FALLA";
  if (/(pago|pagu|deposit|transfer|comprobante|ticket|recibo)/i.test(t)) return "PAGO";
  if (/(horario|ubic|direccion|donde|precio|cost|costo|paquete|plan|info|informacion)/i.test(t)) return "FAQ";

  return null;
}

// umbral: si IA no está segura => menú
const LLM_CONFIDENCE_MIN = Number(process.env.LLM_INTENT_MIN_CONF || 0.70);

// =====================
// Main
// =====================
async function handleInbound({ inbound, send }) {
  const providerMsgId = inbound.providerMsgId || null;
  const inboundText = String(inbound.text || "").trim();

  // 0) Log IN (idempotente por provider_msg_id)
  const insertedIn = await insertWaMessage({
    sessionId: null,
    phoneE164: inbound.phoneE164,
    direction: "IN",
    body: inboundText || "",
    media: inbound.media,
    raw: inbound.raw,
    providerMsgId
  });

  // retry => no respondas
  if (!insertedIn) return;

  // helper send + log OUT
  async function sendAndLog({ sessionId, flow, step, kind, textOut }) {
    let msg = String(textOut || "").trim();

    // polish best-effort (sin romper)
    try {
      const out = await polishReply({
        intent: flow,
        step,
        rawReply: msg,
        userText: inboundText,
        profileName: inbound.profileName || ""
      });
      if (out) msg = String(out).trim();
    } catch {}

    if (msg) await send(msg);

    await insertWaMessage({
      sessionId: sessionId || null,
      phoneE164: inbound.phoneE164,
      direction: "OUT",
      body: msg || null,
      raw: { kind, flow, step }
    });

    return msg;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1) sesión abierta (MISMO CLIENT)
    const existing = await getOpenSessionByPhone(inbound.phoneE164, client);

    // 2) NO hay sesión: si saludo/menu/corto => solo menú (NO crear sesión)
    if (!existing) {
      if (isVeryShort(inboundText) || isGreetingOnly(inboundText) || isMenuWord(inboundText)) {
        await client.query("COMMIT");
        await sendAndLog({
          sessionId: null,
          flow: "MENU",
          step: 0,
          kind: "menu_no_session",
          textOut: menu(inbound.profileName)
        });
        return;
      }

      // 3) Routing determinístico -> IA con umbral
      const nIntent = mapNumberToIntent(inboundText);
      let flow = nIntent;

      if (!flow) {
        const routed = await routeIntent(inboundText);
        const conf = Number(routed?.confidence ?? 0);

        // si IA no está segura => menú
        if (!routed?.intent || conf < LLM_CONFIDENCE_MIN) {
          await client.query("COMMIT");
          await sendAndLog({
            sessionId: null,
            flow: "MENU",
            step: 0,
            kind: "menu_low_conf",
            textOut:
              `Para ayudarte mejor, elige una opción:\n\n${menu(inbound.profileName)}`
          });
          return;
        }

        flow = routed.intent;
      }

      // 4) crea sesión
      const session = await createSession(
        { phoneE164: inbound.phoneE164, flow, step: 1, data: {} },
        client
      );

      let introText = menu(inbound.profileName);
      if (flow === "CONTRATO") introText = contrato.intro(inbound.phoneE164);
      else if (flow === "PAGO") introText = pago.intro();
      else if (flow === "FALLA") introText = falla.intro();
      else introText = faq.intro();

      await client.query("COMMIT");

      await sendAndLog({
        sessionId: session.session_id,
        flow,
        step: 1,
        kind: "intro_new_session",
        textOut: introText
      });

      return;
    }

    // 5) HAY sesión:
    // - "menú" => reset explícito
    if (isMenuWord(inboundText)) {
      await closeSession(existing.session_id, client);
      await client.query("COMMIT");
      await sendAndLog({
        sessionId: null,
        flow: "MENU",
        step: 0,
        kind: "menu_reset",
        textOut: menu(inbound.profileName)
      });
      return;
    }

    // - saludo => no avances flujo, ofrece continuar/menú
    if (isGreetingOnly(inboundText)) {
      await client.query("COMMIT");
      await sendAndLog({
        sessionId: existing.session_id,
        flow: existing.flow || "FAQ",
        step: existing.step || 1,
        kind: "greeting_existing_session",
        textOut: greetingWithSession(existing)
      });
      return;
    }

    // - "continuar" => sigue normal (no hagas nada especial)
    //   (si no dice continuar, igual seguimos al flow, porque ya mandó contenido real)

    // 6) lock FOR UPDATE (MISMO CLIENT / MISMA TX)
    const locked = await lockSession(existing.session_id, client);

    if (!locked) {
      await client.query("COMMIT");
      await sendAndLog({
        sessionId: existing.session_id,
        flow: existing.flow || "FAQ",
        step: existing.step || 1,
        kind: "lock_failed",
        textOut: menu(inbound.profileName)
      });
      return;
    }

    // 7) Ejecutar flow
    const ctx = {
      session: locked,
      inbound,
      send: async (textOut) => {
        await sendAndLog({
          sessionId: locked.session_id,
          flow: locked.flow,
          step: locked.step,
          kind: "flow_reply",
          textOut
        });
      },
      updateSession: async ({ step, data }) => {
        return updateSession({ sessionId: locked.session_id, step, data }, client);
      },
      closeSession: async (sid) => {
        return closeSession(sid || locked.session_id, client);
      }
    };

    if (locked.flow === "CONTRATO") await contrato.handle(ctx);
    else if (locked.flow === "PAGO") await pago.handle(ctx);
    else if (locked.flow === "FALLA") await falla.handle(ctx);
    else await faq.handle(ctx);

    await client.query("COMMIT");
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { handleInbound, menu };