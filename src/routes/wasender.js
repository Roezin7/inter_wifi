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
  normalizePhoneToE164,
  extractProviderMsgId
} = require("../utils/waPayload");

const { sendText } = require("../services/wasenderService");
const { handleInbound, menu } = require("../handlers/inbound");
const { logger } = require("../utils/logger");
const { query } = require("../db");

const router = express.Router();

/**
 * Dedupe HARD: intenta registrar el provider_msg_id como "IN" en DB.
 * Si ya existía (unique), no procesa el flujo.
 *
 * OJO: requiere que wa_messages tenga unique uq_wa_messages_provider_msg_id (ya lo tienes).
 */
async function tryRegisterInboundDedupe({
  providerMsgId,
  phoneE164,
  sessionId,
  body,
  media,
  raw
}) {
  if (!providerMsgId) return { ok: true, inserted: true }; // sin id, no dedupe por DB

  // Insert minimal row (session_id puede ser null aquí)
  // Si choca el unique, no inserta nada.
  const sql = `
    INSERT INTO wa_messages (session_id, phone_e164, direction, body, media, raw, provider_msg_id)
    VALUES ($1,$2,'IN',$3,$4,$5,$6)
    ON CONFLICT (provider_msg_id) DO NOTHING
    RETURNING id
  `;

  const params = [
    sessionId || null,
    phoneE164,
    body || null,
    media ? JSON.stringify(media) : null,
    raw ? JSON.stringify(raw) : null,
    String(providerMsgId)
  ];

  try {
    const { rows } = await query(sql, params);
    if (rows.length === 0) {
      // ya procesado antes
      return { ok: true, inserted: false };
    }
    return { ok: true, inserted: true, id: rows[0].id };
  } catch (e) {
    logger?.warn?.("tryRegisterInboundDedupe failed", e);
    // Si falla DB, no bloqueamos webhook (pero sí podría duplicar)
    return { ok: false, inserted: true };
  }
}

/**
 * Texto robusto (por si cambia payload)
 */
function safeExtractText(payload) {
  try {
    const t = extractText(payload);
    if (typeof t === "string") return t;
  } catch {}

  const b1 = payload?.data?.messages?.messageBody;
  if (typeof b1 === "string") return b1;

  const b2 = payload?.data?.messages?.message?.conversation;
  if (typeof b2 === "string") return b2;

  const b3 = payload?.data?.message?.text?.body;
  if (typeof b3 === "string") return b3;

  return "";
}

router.post("/webhook", async (req, res) => {
  try {
    if (!verifySecret(req)) return res.status(403).send("Forbidden");

    const payload = req.body || {};

    // webhook test
    if (payload.event === "webhook.test" || payload?.data?.test === true) {
      return res.status(200).send("OK");
    }

    // Ignorar mensajes enviados por ti
    if (isFromMe(payload)) return res.status(200).send("OK");

    const providerSession = extractSession(payload);
    const fromRaw = extractFromRaw(payload);
    const phoneE164 = normalizePhoneToE164(fromRaw);
    if (!phoneE164) return res.status(200).send("OK");

    const profileName = extractProfileName(payload);
    const media = extractMedia(payload);
    const inboundText = safeExtractText(payload).trim();
    const providerMsgId = extractProviderMsgId(payload);

    const send = async (textOut) => {
      await sendText({ toE164: phoneE164, text: String(textOut || "") });
    };

    // vacío total
    if (!inboundText && (!media || media.count === 0)) {
      await send(menu(profileName));
      return res.status(200).json({ ok: true });
    }

    // ✅ DEDUPE HARD (DB UNIQUE) ANTES de procesar flujo
    const dedupe = await tryRegisterInboundDedupe({
      providerMsgId,
      phoneE164,
      sessionId: null,
      body: inboundText || null,
      media,
      raw: payload
    });

    // si ya se procesó, salir sin hacer nada
    if (providerMsgId && dedupe.ok && dedupe.inserted === false) {
      return res.status(200).send("OK");
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
    return res.status(200).send("OK");
  }
});

module.exports = router;