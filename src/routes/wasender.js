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

/** provider msg id */
function getProviderMsgId(payload) {
  return (
    payload?.data?.messages?.key?.id ||
    payload?.data?.messages?.id ||
    payload?.data?.message?.id ||
    payload?.id ||
    null
  );
}

/** texto robusto */
function safeExtractText(payload) {
  try {
    const t = extractText(payload);
    if (typeof t === "string") return t;
  } catch {}

  return (
    payload?.data?.messages?.messageBody ||
    payload?.data?.messages?.message?.conversation ||
    payload?.data?.message?.text?.body ||
    ""
  );
}

router.post("/webhook", async (req, res) => {
  try {
    if (!verifySecret(req)) return res.status(403).send("Forbidden");
    const payload = req.body || {};

    if (payload.event === "webhook.test" || payload?.data?.test === true) {
      return res.status(200).send("OK");
    }

    if (isFromMe(payload)) return res.status(200).send("OK");

    const providerSession = extractSession(payload);
    const providerMsgId = getProviderMsgId(payload);

    const fromRaw = extractFromRaw(payload);
    const phoneE164 = normalizePhoneToE164(fromRaw);
    if (!phoneE164) return res.status(200).send("OK");

    const profileName = extractProfileName(payload);
    const media = extractMedia(payload);
    const inboundText = String(safeExtractText(payload) || "").trim();

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