const { pool } = require("../db");
const { routeIntent } = require("../services/llmService");
const { insertWaMessage } = require("../services/messagesService");
const { getOpenSessionByPhone, createSession, lockSession, updateSession, closeSession } = require("../services/sessionsService");

const contrato = require("./flows/contrato");
const pago = require("./flows/pago");
const falla = require("./flows/falla");
const faq = require("./flows/faq");

function menu() {
  return (
    "¡Hola! 👋 Soy el asistente de InterWIFI.\n\n" +
    "¿Qué te gustaría hacer?\n" +
    "1) Contratar internet\n" +
    "2) Reportar falla\n" +
    "3) Registrar pago\n" +
    "4) Dudas (horarios, precios, ubicación)\n\n" +
    "Responde con el número o escríbelo con tus palabras 🙂"
  );
}

function mapNumberToIntent(text) {
  const t = String(text || "").trim();
  if (t === "1") return "CONTRATO";
  if (t === "2") return "FALLA";
  if (t === "3") return "PAGO";
  if (t === "4") return "FAQ";
  return null;
}

async function handleInbound({ inbound, send }) {
  // 1) Log inbound always
  await insertWaMessage({
    sessionId: null,
    phoneE164: inbound.phoneE164,
    direction: "IN",
    body: inbound.text,
    media: inbound.media,
    raw: inbound.raw
  });

  // 2) Existing session?
  const existing = await getOpenSessionByPhone(inbound.phoneE164);

  // helper for consistent api to flow handlers
  const api = {
    send,
    updateSession: ({ step, data }) => updateSession({ sessionId: inbound.sessionId, step, data }),
    closeSession: (sid) => closeSession(sid)
  };

  if (!existing) {
    // First message: route intent
    const nIntent = mapNumberToIntent(inbound.text);
    const { intent } = nIntent
      ? { intent: nIntent }
      : await routeIntent(inbound.text);

    const flow = intent || "FAQ";
    const session = await createSession({
      phoneE164: inbound.phoneE164,
      flow,
      step: 1,
      data: {}
    });

    // Save inbound message with session_id link (optional)
    // (No reinsert; keep it simple)

    // respond intro
    let introText = menu();
    if (flow === "CONTRATO") introText = contrato.intro();
    if (flow === "PAGO") introText = pago.intro();
    if (flow === "FALLA") introText = falla.intro();
    if (flow === "FAQ") introText = faq.intro();

    await send(introText);

    // log outbound
    await insertWaMessage({
      sessionId: session.session_id,
      phoneE164: inbound.phoneE164,
      direction: "OUT",
      body: introText,
      raw: { kind: "intro", flow }
    });

    return;
  }

  // 3) Process with transaction + lock to avoid races
  await pool.query("BEGIN");
  try {
    const locked = await lockSession(existing.session_id);
    if (!locked) {
      await pool.query("COMMIT");
      await send(menu());
      return;
    }

    // attach to inbound
    inbound.sessionId = locked.session_id;

    const ctx = {
      session: locked,
      inbound,
      send: async (text) => {
        await send(text);
        await insertWaMessage({
          sessionId: locked.session_id,
          phoneE164: inbound.phoneE164,
          direction: "OUT",
          body: text,
          raw: { kind: "flow_reply", flow: locked.flow, step: locked.step }
        });
      },
      updateSession: async ({ step, data }) => {
        const updated = await updateSession({ sessionId: locked.session_id, step, data });
        return updated;
      },
      closeSession: async (sid) => closeSession(sid)
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