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
const { query } = require("../db"); // dedupe rápido

const router = express.Router();

/**
 * Dedupe: true si ya procesamos ese provider_msg_id
 */
async function alreadyProcessed(providerMsgId) {
  if (!providerMsgId) return false;
  try {
    const { rows } = await query(
      "SELECT 1 FROM wa_messages WHERE provider_msg_id = $1 LIMIT 1",
      [String(providerMsgId)]
    );
    return rows.length > 0;
  } catch (e) {
    // si falla el query, no bloquees el webhook
    logger?.warn?.("alreadyProcessed check failed", e);
    return false;
  }
}

/**
 * Extrae provider message id desde distintos formatos
 */
function getProviderMsgId(payload) {
  // Wasender real (como tu log): data.messages.key.id
  const id1 = payload?.data?.messages?.key?.id;
  if (id1) return String(id1);

  // variantes posibles
  const id2 = payload?.data?.messages?.id;
  if (id2) return String(id2);

  const id3 = payload?.data?.message?.id;
  if (id3) return String(id3);

  const id4 = payload?.id;
  if (id4) return String(id4);

  return null;
}

/**
 * Extrae texto robusto incluso si extractText no cubre cambios de payload
 */
function safeExtractText(payload) {
  // intento 1: extractor existente
  try {
    const t = extractText(payload);
    if (typeof t === "string") return t;
  } catch {}

  // Wasender real: data.messages.messageBody o message.conversation
  const b1 = payload?.data?.messages?.messageBody;
  if (typeof b1 === "string") return b1;

  const b2 = payload?.data?.messages?.message?.conversation;
  if (typeof b2 === "string") return b2;

  // otro formato común
  const b3 = payload?.data?.message?.text?.body;
  if (typeof b3 === "string") return b3;

  return "";
}

/**
 * POST /wasender/webhook
 */
router.post("/webhook", async (req, res) => {
  // Wasender puede reintentar: intenta siempre responder 200
  try {
    if (!verifySecret(req)) return res.status(403).send("Forbidden");

    const payload = req.body || {};

    // webhook test
    if (payload.event === "webhook.test" || payload?.data?.test === true) {
      return res.status(200).send("OK");
    }

    // Ignorar mensajes enviados por ti (fromMe)
    // (OJO: esto va antes del dedupe para evitar queries innecesarios)
    if (isFromMe(payload)) return res.status(200).send("OK");

    // provider msg id
    const providerMsgId = getProviderMsgId(payload);

    // dedupe por msg id (si existe)
    if (providerMsgId) {
      const seen = await alreadyProcessed(providerMsgId);
      if (seen) return res.status(200).send("OK");
    }

    // session/provider data
    const providerSession = extractSession(payload);
    const fromRaw = extractFromRaw(payload);
    const phoneE164 = normalizePhoneToE164(fromRaw);

    if (!phoneE164) return res.status(200).send("OK");

    const profileName = extractProfileName(payload);
    const media = extractMedia(payload);

    const inboundText = safeExtractText(payload).trim();

    // helper send
    const send = async (textOut) => {
      await sendText({ toE164: phoneE164, text: String(textOut || "") });
    };

    // mensaje totalmente vacío (sin texto y sin media)
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
        providerMsgId
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