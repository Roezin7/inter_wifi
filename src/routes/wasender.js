// src/routes/wasender.js
const express = require("express");
const { verifySecret } = require("../utils/waSecurity");
const {
  isFromMe,
  extractSession,
  extractFromRaw,
  extractProfileName,
  extractMedia,
  normalizePhoneToE164,
  extractText
} = require("../utils/waPayload");

const { sendText } = require("../services/wasenderService");
const { handleInbound, menu } = require("../handlers/inbound");
const { logger } = require("../utils/logger");

const router = express.Router();

/**
 * ✅ PRO: Extractor tolerante a estructuras distintas (messages array / object)
 * La meta: SIEMPRE sacar un ID estable si existe.
 */
function getProviderMsgId(payload) {
  try {
    // 1) formatos comunes directos
    const direct =
      payload?.providerMsgId ||
      payload?.messageId ||
      payload?.data?.message?.id ||
      payload?.data?.messages?.id ||
      payload?.id;

    if (direct) return String(direct);

    // 2) messages puede ser array u objeto
    const msgs = payload?.data?.messages;

    // array
    if (Array.isArray(msgs) && msgs.length) {
      const m0 = msgs[0];
      const id =
        m0?.id ||
        m0?.key?.id ||
        m0?.messageId ||
        m0?.message_id ||
        m0?.msgId ||
        null;
      if (id) return String(id);
    }

    // objeto
    if (msgs && typeof msgs === "object") {
      const id =
        msgs?.id ||
        msgs?.key?.id ||
        msgs?.messageId ||
        msgs?.message_id ||
        msgs?.msgId ||
        null;
      if (id) return String(id);
    }

    // 3) backups raros
    const alt =
      payload?.data?.key?.id ||
      payload?.data?.id ||
      payload?.data?.messageId ||
      null;

    return alt ? String(alt) : null;
  } catch {
    return null;
  }
}

/**
 * ✅ Texto robusto (si extractText falla o no aplica)
 */
function safeExtractText(payload) {
  try {
    const t = extractText(payload);
    if (typeof t === "string") return t;
  } catch {}

  const msgs = payload?.data?.messages;

  // array
  if (Array.isArray(msgs) && msgs.length) {
    const m0 = msgs[0];
    return (
      m0?.messageBody ||
      m0?.message?.conversation ||
      m0?.message?.extendedTextMessage?.text ||
      m0?.text ||
      ""
    );
  }

  // objeto
  return (
    payload?.data?.messages?.messageBody ||
    payload?.data?.messages?.message?.conversation ||
    payload?.data?.messages?.message?.extendedTextMessage?.text ||
    payload?.data?.message?.text?.body ||
    payload?.data?.message?.conversation ||
    payload?.text ||
    ""
  );
}

/**
 * ✅ Normaliza media al formato que tu bot usa:
 * inbound.media.urls[] y inbound.media.count
 */
function normalizeInboundMedia(media) {
  if (!media) return { urls: [], count: 0 };

  // si ya viene como { urls, count }
  if (Array.isArray(media.urls)) {
    return {
      urls: media.urls.filter(Boolean).map(String),
      count: Number(media.count || media.urls.length || 0)
    };
  }

  // si viene como { url }
  if (media.url) {
    return { urls: [String(media.url)], count: 1 };
  }

  // si viene como array
  if (Array.isArray(media)) {
    const urls = media
      .map((m) => m?.url || m?.href || m?.link || m)
      .filter(Boolean)
      .map(String);
    return { urls, count: urls.length };
  }

  // si viene como { media: [...] }
  if (Array.isArray(media.media)) {
    const urls = media.media
      .map((m) => m?.url || m?.href || m?.link || m)
      .filter(Boolean)
      .map(String);
    return { urls, count: urls.length };
  }

  return { urls: [], count: 0 };
}

router.post("/webhook", async (req, res) => {
  // ✅ SIEMPRE responder 200 rápido para que el proveedor no reintente por timeout.
  // (Tu dedupe real vive en insertWaMessage / provider_dedupe_key)
  res.status(200).json({ ok: true });

  try {
    if (!verifySecret(req)) return; // ya respondimos

    const payload = req.body || {};

    // Ignora tests
    if (payload.event === "webhook.test" || payload?.data?.test === true) return;

    // Ignora mensajes que tú mismo enviaste
    if (isFromMe(payload)) return;

    const providerMsgId = getProviderMsgId(payload);

    const providerSession = extractSession(payload);
    const fromRaw = extractFromRaw(payload);
    const phoneE164 = normalizePhoneToE164(fromRaw);
    if (!phoneE164) return;

    const profileName = extractProfileName(payload);
    const rawMedia = extractMedia(payload);
    const media = normalizeInboundMedia(rawMedia);

    const inboundText = String(safeExtractText(payload) || "").trim();

    const send = async (textOut) => {
      await sendText({ toE164: phoneE164, text: String(textOut || "") });
    };

    // ✅ si llega vacío total, solo manda menú (SIN abrir sesión)
    if (!inboundText && (!media || media.count === 0)) {
      await send(menu(profileName));
      return;
    }

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
  } catch (err) {
    logger?.error?.("Webhook error", err);
    // ya respondimos 200 arriba, no rethrow
  }
});

module.exports = router;