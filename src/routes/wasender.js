// src/routes/wasender.js
const express = require("express");
const { verifySecret } = require("../utils/waSecurity");
const {
  isFromMe,
  extractSession,
  extractText,
  extractFromRaw,
  extractProfileName,
  extractMedia,
  normalizePhoneToE164
} = require("../utils/waPayload");

const { sendText } = require("../services/wasenderService");
const { handleInbound, menu } = require("../handlers/inbound");
const { logger } = require("../utils/logger");
const { query } = require("../db"); // para dedupe rápido (sin depender de otro service)

const router = express.Router();

/**
 * Dedupe: regresa true si ya procesamos ese msg_id
 */
async function alreadyProcessed(providerMsgId) {
  if (!providerMsgId) return false;
  try {
    const { rows } = await query(
      "SELECT 1 FROM wa_messages WHERE provider_msg_id = $1 LIMIT 1",
      [String(providerMsgId)]
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

/**
 * Extrae provider msg id desde distintos formatos
 */
function getProviderMsgId(payload) {
  // Wasender real (como tu log):
  const id1 = payload?.data?.messages?.key?.id;
  if (id1) return String(id1);

  // Tu mock anterior:
  const id2 = payload?.data?.message?.id;
  if (id2) return String(id2);

  // fallback
  const id3 = payload?.id;
  if (id3) return String(id3);

  return null;
}

/**
 * Extrae texto de forma “bulletproof” incluso si extractText no cubre el payload nuevo
 */
function safeExtractText(payload) {
  try {
    const t = extractText(payload);
    if (typeof t === "string") return t;
  } catch {}

  // Wasender real log: data.messages.messageBody o message.conversation
  const b1 = payload?.data?.messages?.messageBody;
  if (typeof b1 === "string") return b1;

  const b2 = payload?.data?.messages?.message?.conversation;
  if (typeof b2 === "string") return b2;

  // Mock: data.message.text.body
  const b3 = payload?.data?.message?.text?.body;
  if (typeof b3 === "string") return b3;

  return "";
}

router.post("/webhook", async (req, res) => {
  // Importante: Wasender reintenta; siempre contesta 200 cuando puedas
  try {
    if (!verifySecret(req)) return res.status(403).send("Forbidden");

    const payload = req.body || {};

    // webhook test
    if (payload.event === "webhook.test" || payload?.data?.test === true) {
      return res.status(200).send("OK");
    }

    // dedupe por msg id
    const providerMsgId = getProviderMsgId(payload);
    if (providerMsgId) {
      const seen = await alreadyProcessed(providerMsgId);
      if (seen) return res.status(200).send("OK");
    }

    // ignorar mensajes fromMe
    if (isFromMe(payload)) return res.status(200).send("OK");

    const providerSession = extractSession(payload); // id de instancia/session de Wasender
    const fromRaw = extractFromRaw(payload);
    const phoneE164 = normalizePhoneToE164(fromRaw);

    if (!phoneE164) return res.status(200).send("OK");

    const profileName = extractProfileName(payload);
    const media = extractMedia(payload);

    const inboundText = safeExtractText(payload).trim();

    // helper send (Wasender)
    const send = async (textOut) => {
      await sendText({ toE164: phoneE164, text: String(textOut || "") });
    };

    // Si viene totalmente vacío (sin texto ni media), responde con saludo natural
    if (!inboundText && (!media || media.count === 0)) {
      await send(menu(profileName));
      return res.status(200).json({ ok: true });
    }

    // Ejecutar flujo
    await handleInbound({
      inbound: {
        phoneE164,
        profileName,
        text: inboundText,
        media,
        raw: payload,
        providerSession,
        providerMsgId // <- pásalo para guardar en DB
      },
      send
    });

    return res.status(200).json({ ok: true });
  } catch (err) {
    logger.error("Webhook error", err);
    // 200 para que Wasender no reintente infinito
    return res.status(200).send("OK");
  }
});

module.exports = router;