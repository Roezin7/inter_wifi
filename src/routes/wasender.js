// src/routes/wasender.js
const express = require("express");
const { verifySecret } = require("../utils/waSecurity");
const {
  isFromMe,
  extractSession,
  extractFromRaw,
  extractProfileName,
  normalizePhoneToE164,
  extractText,
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
    const direct =
      payload?.providerMsgId ||
      payload?.messageId ||
      payload?.data?.message?.id ||
      payload?.data?.messages?.id ||
      payload?.id;

    if (direct) return String(direct);

    const msgs = payload?.data?.messages;

    if (Array.isArray(msgs) && msgs.length) {
      const m0 = msgs[0];
      const id = m0?.id || m0?.key?.id || m0?.messageId || m0?.message_id || m0?.msgId || null;
      if (id) return String(id);
    }

    if (msgs && typeof msgs === "object") {
      const id = msgs?.id || msgs?.key?.id || msgs?.messageId || msgs?.message_id || msgs?.msgId || null;
      if (id) return String(id);
    }

    const alt = payload?.data?.key?.id || payload?.data?.id || payload?.data?.messageId || null;
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
 * ✅ Extrae 1 media "raw" desde payload Wasender:
 * payload.data.messages.message.{imageMessage|documentMessage|videoMessage|audioMessage|stickerMessage}
 */
function extractWasenderMedia(payload) {
  const msg = payload?.data?.messages?.message;

  if (!msg || typeof msg !== "object") return null;

  if (msg.imageMessage) return { ...msg.imageMessage, _type: "image" };
  if (msg.documentMessage) return { ...msg.documentMessage, _type: "document" };
  if (msg.videoMessage) return { ...msg.videoMessage, _type: "video" };
  if (msg.audioMessage) return { ...msg.audioMessage, _type: "audio" };
  if (msg.stickerMessage) return { ...msg.stickerMessage, _type: "sticker" };

  return null;
}

/**
 * ✅ Normaliza media al formato que tu bot usa:
 * inbound.media.urls[] + inbound.media.count
 * y además conserva inbound.media.items[] con meta (mediaKey/mimetype/id...)
 */
function normalizeInboundMedia(media) {
  const out = { urls: [], count: 0, items: [] };
  if (!media) return out;

  // Legacy: ya viene como { urls, count } (y tal vez items)
  if (Array.isArray(media.urls)) {
    out.urls = media.urls.filter(Boolean).map(String);
    out.count = Number(media.count || out.urls.length || 0);
    if (Array.isArray(media.items)) out.items = media.items;
    return out;
  }

  // Wasender raw: { url, mediaKey, mimetype, fileName... }
  const url = media.url || media.href || media.link || null;
  if (url) {
    out.urls = [String(url)];
    out.count = 1;
    out.items = [
      {
        url: String(url),
        id: media.id || media.mediaId || media.messageId || null,
        mimetype: media.mimetype || media.mimeType || null,
        mediaKey: media.mediaKey || null,
        fileName: media.fileName || null,
        fileLength: media.fileLength || null,
        sha256: media.fileSha256 || media.sha256 || null,
        type: media._type || null,
      },
    ];
    return out;
  }

  // Array de medias
  if (Array.isArray(media)) {
    const items = media
      .map((m) => {
        const u = m?.url || m?.href || m?.link || null;
        if (!u) return null;
        return {
          url: String(u),
          id: m?.id || m?.mediaId || m?.messageId || null,
          mimetype: m?.mimetype || m?.mimeType || null,
          mediaKey: m?.mediaKey || null,
          fileName: m?.fileName || null,
          fileLength: m?.fileLength || null,
          sha256: m?.fileSha256 || m?.sha256 || null,
          type: m?._type || null,
        };
      })
      .filter(Boolean);

    out.items = items;
    out.urls = items.map((x) => x.url);
    out.count = out.urls.length;
    return out;
  }

  // { media: [...] }
  if (Array.isArray(media.media)) {
    return normalizeInboundMedia(media.media);
  }

  return out;
}

/**
 * ✅ Debug seguro: recorta payload para logs
 * (evita logs gigantes y filtra cosas obvias)
 */
function safePayloadPreview(payload) {
  try {
    const p = payload || {};
    const msg = p?.data?.messages?.message || null;
    const key = p?.data?.messages?.key || null;

    // Preview chico
    return {
      event: p?.event || null,
      fromMe: !!isFromMe(p),
      hasData: !!p?.data,
      key: key
        ? {
            id: key?.id,
            remoteJid: key?.remoteJid,
            cleanedSenderPn: key?.cleanedSenderPn,
            cleanedParticipantPn: key?.cleanedParticipantPn,
          }
        : null,
      messageBody: p?.data?.messages?.messageBody || null,
      mediaKinds: {
        image: !!msg?.imageMessage,
        document: !!msg?.documentMessage,
        video: !!msg?.videoMessage,
        audio: !!msg?.audioMessage,
        sticker: !!msg?.stickerMessage,
      },
    };
  } catch {
    return { note: "preview_failed" };
  }
}

router.post("/webhook", async (req, res) => {
  // ✅ SIEMPRE responder 200 rápido
  res.status(200).json({ ok: true });

  try {
    if (!verifySecret(req)) return;

    const payload = req.body || {};

    // Ignora tests
    if (payload.event === "webhook.test" || payload?.data?.test === true) return;

    // Ignora mensajes que tú mismo enviaste
    if (isFromMe(payload)) return;

    // ✅ DEBUG: payload preview + media crudo
    console.log("[WASENDER] payload.preview =", JSON.stringify(safePayloadPreview(payload), null, 2));

    const rawMedia = extractWasenderMedia(payload);
    if (rawMedia) {
      console.log("[WASENDER] rawMedia.type =", rawMedia?._type || null);
      console.log("[WASENDER] rawMedia =", JSON.stringify(rawMedia, null, 2));
    }

    const providerMsgId = getProviderMsgId(payload);

    const providerSession = extractSession(payload);
    const fromRaw = extractFromRaw(payload);
    const phoneE164 = normalizePhoneToE164(fromRaw);
    if (!phoneE164) return;

    const profileName = extractProfileName(payload);

    // ✅ Usa media desde payload (con mediaKey/mimetype)
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
        raw: payload, // ✅ aquí está el payload completo si lo ocupas en flows
        providerSession,
        providerMsgId,
      },
      send,
    });
  } catch (err) {
    logger?.error?.("Webhook error", err);
  }
});

module.exports = router;