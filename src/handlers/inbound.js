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

  if (/(contrat|instal|servicio|internet)/i.test(t)) return "CONTRATO";
  if (/(falla|no (tengo|hay) internet|sin internet|intermit|lento|no carga)/i.test(t)) return "FALLA";
  if (/(pago|pagu|deposit|transfer|comprobante|ticket)/i.test(t)) return "PAGO";
  if (/(horario|ubic|direccion|donde|precio|cost|costo|paquete|plan)/i.test(t)) return "FAQ";

  return null;
}

function isGreeting(text) {
  const s = String(text || "").trim().toLowerCase();
  if (!s) return true;
  return /^(hola+|hey+|hi+|buenas|buenos dias|buen dia|buenas tardes|buenas noches|que onda|qué onda|q onda|ola)\b/.test(s);
}

function isMenuWord(text) {
  const s = String(text || "").trim().toLowerCase();
  return /^(menu|menú|inicio|start|volver|regresar|opciones)$/i.test(s);
}

/**
 * handleInbound: corre SIEMPRE en 1 sola conexión (client) para que:
 * - SELECT FOR UPDATE sí bloquee
 * - updateSession/closeSession no se “vayan” a otra conexión
 * - evites race conditions / loops
 */
async function handleInbound({ inbound, send }) {
  const providerMsgId = inbound.providerMsgId || null;

  // 0) Dedupe hard (idempotente)
  // insertWaMessage debe hacer INSERT ... ON CONFLICT(provider_msg_id) DO NOTHING RETURNING ...
  const insertedIn = await insertWaMessage({
    sessionId: null,
    phoneE164: inbound.phoneE164,
    direction: "IN",
    body: inbound.text || "",
    media: inbound.media,
    raw: inbound.raw,
    providerMsgId
  });

  // Si ya existía ese msg_id => era retry => NO respondas otra vez
  if (!insertedIn) return;

  // helper send + log OUT (NO revienta si falla LLM)
  async function sendAndLog({ sessionId, flow, step, kind, textOut }) {
    let polished = String(textOut || "").trim();

    try {
      const out = await polishReply({
        intent: flow,
        step,
        rawReply: polished,
        userText: inbound.text || "",
        profileName: inbound.profileName || ""
      });
      if (out) polished = String(out).trim();
    } catch {
      // noop
    }

    if (polished) {
      await send(polished);
    }

    // OUT log (sin provider_msg_id)
    await insertWaMessage({
      sessionId: sessionId || null,
      phoneE164: inbound.phoneE164,
      direction: "OUT",
      body: polished || null,
      raw: { kind, flow, step }
    });

    return polished;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1) buscar sesión OPEN (MISMO client)
    let existing = await getOpenSessionByPhone(inbound.phoneE164, client);

    const inboundText = String(inbound.text || "").trim();

    // 2) Si NO hay sesión: si es saludo / menu / corto => NO abras sesión, manda menú y termina
    if (!existing) {
      if (!inboundText || inboundText.length < 3 || isGreeting(inboundText) || isMenuWord(inboundText)) {
        await client.query("COMMIT");
        await sendAndLog({
          sessionId: null,
          flow: "MENU",
          step: 0,
          kind: "menu",
          textOut: menu(inbound.profileName)
        });
        return;
      }

      // 3) rutea + crea sesión
      const nIntent = mapNumberToIntent(inboundText);
      const routed = nIntent ? { intent: nIntent } : await routeIntent(inboundText);
      const flow = routed?.intent || "FAQ";

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
        kind: "intro",
        textOut: introText
      });

      return;
    }

    // 4) Con sesión existente: lock FOR UPDATE (MISMO TX / MISMO CLIENT)
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

    // 5) Ejecuta flow handler
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