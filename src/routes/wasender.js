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

const router = express.Router();

/** Provider msg id robusto */
function getProviderMsgId(payload) {
  const id1 = payload?.data?.messages?.key?.id;
  if (id1) return String(id1);
  const id2 = payload?.data?.messages?.id;
  if (id2) return String(id2);
  const id3 = payload?.data?.message?.id;
  if (id3) return String(id3);
  const id4 = payload?.id;
  if (id4) return String(id4);
  return null;
}

/** Texto robusto */
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

    // test webhook
    if (payload.event === "webhook.test" || payload?.data?.test === true) {
      return res.status(200).send("OK");
    }

    // ignorar fromMe
    if (isFromMe(payload)) return res.status(200).send("OK");

    const providerMsgId = getProviderMsgId(payload);
    const providerSession = extractSession(payload);

    const fromRaw = extractFromRaw(payload);
    const phoneE164 = normalizePhoneToE164(fromRaw);
    if (!phoneE164) return res.status(200).send("OK");

    const profileName = extractProfileName(payload);
    const media = extractMedia(payload);
    const inboundText = safeExtractText(payload).trim();

    const send = async (textOut) => {
      await sendText({ toE164: phoneE164, text: String(textOut || "") });
    };

    if (!inboundText && (!media || media.count === 0)) {
      await send(menu(profileName));
      return res.status(200).json({ ok: true });
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

    return res.status(200).json({ ok: true });
  } catch (err) {
    logger.error("Webhook error", err);
    return res.status(200).send("OK");
  }
});

module.exports = router;