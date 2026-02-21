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
// UI TEXT
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
  const flow = String(existing?.flow || "").toUpperCase();
  const label =
    flow === "CONTRATO" ? "contratación" :
    flow === "PAGO" ? "registro de pago" :
    flow === "FALLA" ? "reporte de falla" : "información";

  return (
    `¡Hola! 👋\n` +
    `Veo que tienes un proceso abierto de *${label}*.\n` +
    `¿Quieres *continuar* o prefieres ver el *menú*?\n` +
    `Responde: continuar o menú.`
  );
}

// =====================
// TEXT HELPERS
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

  const business =
    /(contrat|internet|pago|falla|deposit|transfer|plan|paquete|horario|direccion|ubic)/i.test(t);
  if (business) return false;

  return /^(hola|hol|hey|hi|ola|buenas|buenos dias|buenas tardes|buenas noches|que tal|q tal|que onda)$/.test(t);
}

function isMenuWord(text) {
  return /^(menu|menú|inicio|opciones|volver|regresar)$/i.test(norm(text));
}

function isContinueWord(text) {
  return /^(continuar|seguir|continue|dale|ok|va|sí|si)$/i.test(norm(text));
}

function parseMenuChoice(text) {
  const t = norm(text);
  if (t === "1") return "CONTRATO";
  if (t === "2") return "FALLA";
  if (t === "3") return "PAGO";
  if (t === "4") return "FAQ";
  return null;
}

function getIntro(flow, inbound) {
  if (flow === "CONTRATO") return contrato.intro(inbound.phoneE164);
  if (flow === "PAGO") return pago.intro();
  if (flow === "FALLA") return falla.intro();
  return faq.intro();
}

// =====================
// MAIN
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
    providerMsgId
  });

  if (!inserted) return; // retry

  async function sendAndLog({ sessionId, flow, step, text }) {
    let msg = text;

    try {
      const out = await polishReply({
        intent: flow,
        step,
        rawReply: msg,
        userText: inboundText,
        profileName: inbound.profileName || ""
      });
      if (out) msg = out;
    } catch {}

    if (msg) await send(msg);

    await insertWaMessage({
      sessionId,
      phoneE164: inbound.phoneE164,
      direction: "OUT",
      body: msg,
      raw: { flow, step }
    });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const existing = await getOpenSessionByPhone(inbound.phoneE164, client);
    const numberChoice = parseMenuChoice(inboundText);

    // =====================
    // NO SESSION
    // =====================
    if (!existing) {
      if (!inboundText || isGreetingOnly(inboundText) || isMenuWord(inboundText)) {
        await client.query("COMMIT");
        await sendAndLog({ sessionId: null, flow: "MENU", step: 0, text: menu(inbound.profileName) });
        return;
      }

      const flow = numberChoice ||
        mapIntentFast(inboundText) ||
        (await routeIntent(inboundText))?.intent ||
        "FAQ";

      const session = await createSession(
        { phoneE164: inbound.phoneE164, flow, step: 1, data: {} },
        client
      );

      await client.query("COMMIT");
      await sendAndLog({ sessionId: session.session_id, flow, step: 1, text: getIntro(flow, inbound) });
      return;
    }

    // =====================
    // SESSION EXISTS
    // =====================

    // 1️⃣ Cambiar flow con número (PRIORIDAD MÁXIMA)
    if (numberChoice) {
      await closeSession(existing.session_id, client);

      const newSession = await createSession(
        { phoneE164: inbound.phoneE164, flow: numberChoice, step: 1, data: {} },
        client
      );

      await client.query("COMMIT");
      await sendAndLog({
        sessionId: newSession.session_id,
        flow: numberChoice,
        step: 1,
        text: getIntro(numberChoice, inbound)
      });
      return;
    }

    // 2️⃣ Menú sin cerrar sesión
    if (isMenuWord(inboundText)) {
      await client.query("COMMIT");
      await sendAndLog({
        sessionId: existing.session_id,
        flow: existing.flow,
        step: existing.step,
        text: greetingWithSession(existing) + "\n\n" + menu(inbound.profileName)
      });
      return;
    }

    // 3️⃣ Saludo
    if (isGreetingOnly(inboundText)) {
      await client.query("COMMIT");
      await sendAndLog({
        sessionId: existing.session_id,
        flow: existing.flow,
        step: existing.step,
        text: greetingWithSession(existing)
      });
      return;
    }

    // 4️⃣ Continuar → sigue normal

    const locked = await lockSession(existing.session_id, client);
    if (!locked) {
      await client.query("COMMIT");
      await sendAndLog({
        sessionId: existing.session_id,
        flow: existing.flow,
        step: existing.step,
        text: menu(inbound.profileName)
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
          text: textOut
        });
      },
      updateSession: async ({ step, data }) =>
        updateSession({ sessionId: locked.session_id, step, data }, client),
      closeSession: async () =>
        closeSession(locked.session_id, client)
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

// routing rápido sin IA
function mapIntentFast(text) {
  const t = norm(text);
  if (/(contrat|internet|instal)/i.test(t)) return "CONTRATO";
  if (/(falla|sin internet|no funciona)/i.test(t)) return "FALLA";
  if (/(pago|deposit|transfer|comprobante)/i.test(t)) return "PAGO";
  if (/(horario|ubic|direccion|info)/i.test(t)) return "FAQ";
  return null;
}

module.exports = { handleInbound, menu };