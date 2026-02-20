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
const { query } = require("../db");

const router = express.Router();

function getProviderMsgId(payload) {
  return (
    payload?.data?.messages?.key?.id ||
    payload?.data?.messages?.id ||
    payload?.data?.message?.id ||
    payload?.id ||
    null
  );
}

async function alreadyProcessed(providerMsgId) {
  if (!providerMsgId) return false;
  try {
    const { rows } = await query(
      "SELECT 1 FROM wa_messages WHERE provider_msg_id = $1 LIMIT 1",
      [String(providerMsgId)]
    );
    return rows.length > 0;
  } catch (e) {
    logger?.warn?.("alreadyProcessed failed", e);
    return false;
  }
}

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

    const providerMsgId = getProviderMsgId(payload);
    if (providerMsgId) {
      const seen = await alreadyProcessed(providerMsgId);
      if (seen) return res.status(200).send("OK");
    }

    const providerSession = extractSession(payload);
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