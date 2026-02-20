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

function menu(profileName) {
  const name = profileName ? ` ${profileName}` : "";
  return (
    `¡Hola${name}! 👋\n` +
    `Soy del equipo de InterWIFI.\n\n` +
    `¿En qué te ayudo hoy?\n` +
    `• Contratar internet\n` +
    `• Reportar una falla\n` +
    `• Registrar un pago\n` +
    `• Info (horarios, ubicación, formas de pago)\n\n` +
    `Puedes escribirlo tal cual (ej. “contratar”) o si prefieres 1, 2, 3, 4 🙂`
  );
}

function mapNumberToIntent(text) {
  const t = String(text || "").trim().toLowerCase();

  if (t === "1") return "CONTRATO";
  if (t === "2") return "FALLA";
  if (t === "3") return "PAGO";
  if (t === "4") return "FAQ";

  if (/(contrat|instal|servicio|internet)/i.test(t)) return "CONTRATO";
  if (/(falla|no (tengo|hay) internet|sin internet|intermit|lento|no carga)/i.test(t)) return "FALLA";
  if (/(pago|pagu|deposit|transfer|comprobante|ticket)/i.test(t)) return "PAGO";
  if (/(horario|ubic|direccion|donde|precio|cost|costo|paquete|plan)/i.test(t)) return "FAQ";

  return null;
}

async function handleInbound({ inbound, send }) {
  // 1) Log inbound siempre (con provider_msg_id para dedupe real)
  const inserted = await insertWaMessage({
    sessionId: null,
    phoneE164: inbound.phoneE164,
    direction: "IN",
    body: inbound.text || "",
    media: inbound.media,
    raw: inbound.raw,
    providerMsgId: inbound.providerMsgId // ✅
  });

  // Si ya existía (dedupe), NO proceses otra vez
  if (inbound.providerMsgId && inserted === null) {
    return;
  }

  const existing = await getOpenSessionByPhone(inbound.phoneE164);

  async function sendAndLog({ sessionId, flow, step, kind, textOut }) {
    let polished = textOut;
    try {
      polished = await polishReply({
        intent: flow,
        step,
        rawReply: textOut,
        userText: inbound.text || "",
        profileName: inbound.profileName || ""
      });
    } catch {
      polished = textOut;
    }

    await send(polished);

    // OUT no necesita providerMsgId (si no lo tienes), déjalo null
    await insertWaMessage({
      sessionId: sessionId || null,
      phoneE164: inbound.phoneE164,
      direction: "OUT",
      body: polished,
      raw: { kind, flow, step },
      providerMsgId: null
    });

    return polished;
  }

  // 2) Si NO hay sesión: crear y responder intro
  if (!existing) {
    const nIntent = mapNumberToIntent(inbound.text);

    const routed = nIntent
      ? { intent: nIntent }
      : await routeIntent(inbound.text || "");

    const flow = routed?.intent || "FAQ";

    const session = await createSession({
      phoneE164: inbound.phoneE164,
      flow,
      step: 1,
      data: {}
    });

    let introText = menu(inbound.profileName);
    if (flow === "CONTRATO") introText = contrato.intro(inbound.phoneE164);
    else if (flow === "PAGO") introText = pago.intro(inbound.phoneE164);
    else if (flow === "FALLA") introText = falla.intro(inbound.phoneE164);
    else introText = faq.intro(inbound.phoneE164);

    await sendAndLog({
      sessionId: session.session_id,
      flow,
      step: 1,
      kind: "intro",
      textOut: introText
    });

    return;
  }

  // 3) Con sesión existente: lock + handler
  await pool.query("BEGIN");
  try {
    const locked = await lockSession(existing.session_id);

    if (!locked) {
      await pool.query("COMMIT");
      await sendAndLog({
        sessionId: existing.session_id,
        flow: existing.flow || "FAQ",
        step: existing.step || 1,
        kind: "lock_failed",
        textOut: menu(inbound.profileName)
      });
      return;
    }

    inbound.sessionId = locked.session_id;

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
        return await updateSession({ sessionId: locked.session_id, step, data });
      },
      closeSession: async (sid) => closeSession(sid || locked.session_id)
    };

    if (locked.flow === "CONTRATO") await contrato.handle(ctx);
    else if (locked.flow === "PAGO") await pago.handle(ctx);
    else if (locked.flow === "FALLA") await falla.handle(ctx);
    else await faq.handle(ctx);

    await pool.query("COMMIT");
  } catch (e) {
    await pool.query("ROLLBACK");
    throw e;
  }
}

module.exports = { handleInbound, menu };