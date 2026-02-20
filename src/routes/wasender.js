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

async function alreadyProcessed(providerMsgId) {
  if (!providerMsgId) return false;
  const { rows } = await query(
    "select 1 from wa_messages where provider_msg_id = $1 limit 1",
    [String(providerMsgId)]
  );
  return rows.length > 0;
}

function safeExtractText(payload) {
  try {
    const t = extractText(payload);
    if (typeof t === "string") return t;
  } catch {}
  const b1 = payload?.data?.messages?.messageBody;
  if (typeof b1 === "string") return b1;
  const b2 = payload?.data?.messages?.message?.conversation;
  if (typeof b2 === "string") return b2;
  return "";
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

    // ✅ dedupe ultra temprano
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
    const inboundText = safeExtractText(payload).trim();

    const send = async (textOut) =>
      sendText({ toE164: phoneE164, text: String(textOut || "") });

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