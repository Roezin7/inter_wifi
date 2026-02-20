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
    `Puedes responder con una opción (ej. “contratar”) o con 1, 2, 3, 4 🙂`
  );
}

function mapNumberToIntent(text) {
  const t = String(text || "").trim().toLowerCase();

  if (t === "1") return "CONTRATO";
  if (t === "2") return "FALLA";
  if (t === "3") return "PAGO";
  if (t === "4") return "FAQ";

  // También acepta palabras
  if (/(contrat|instal|servicio|internet)/i.test(t)) return "CONTRATO";
  if (/(falla|no (tengo|hay) internet|sin internet|intermit|lento|no carga)/i.test(t)) return "FALLA";
  if (/(pago|pagu|deposit|transfer|comprobante|ticket)/i.test(t)) return "PAGO";
  if (/(horario|ubic|direccion|donde|precio|cost|costo|paquete|plan)/i.test(t)) return "FAQ";

  return null;
}

async function handleInbound({ inbound, send }) {
  // 1) Log inbound siempre
  await insertWaMessage({
    sessionId: null,
    phoneE164: inbound.phoneE164,
    direction: "IN",
    body: inbound.text || "",
    media: inbound.media,
    raw: inbound.raw
  });

  // 2) Buscar sesión abierta
  const existing = await getOpenSessionByPhone(inbound.phoneE164);

  // helper para “send + log OUT” consistente
  async function sendAndLog({ sessionId, flow, step, kind, textOut }) {
    const polished = await polishReply({
      intent: flow,
      step,
      rawReply: textOut,
      userText: inbound.text || "",
      profileName: inbound.profileName || ""
    });

    await send(polished);

    await insertWaMessage({
      sessionId: sessionId || null,
      phoneE164: inbound.phoneE164,
      direction: "OUT",
      body: polished,
      raw: { kind, flow, step }
    });

    return polished;
  }

  // 3) Si NO hay sesión: enrutamos intención y creamos sesión
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
    if (flow === "CONTRATO") introText = contrato.intro();
    else if (flow === "PAGO") introText = pago.intro();
    else if (flow === "FALLA") introText = falla.intro();
    else introText = faq.intro();

    await sendAndLog({
      sessionId: session.session_id,
      flow,
      step: 1,
      kind: "intro",
      textOut: introText
    });

    return;
  }

  // 4) Con sesión existente: transacción + lock
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
        // FIX: antes estabas usando inbound.sessionId en api.updateSession sin estar asignado
        return await updateSession({ sessionId: locked.session_id, step, data });
      },
      closeSession: async (sid) => closeSession(sid || locked.session_id)
    };

    // 5) Ejecuta flow handler
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