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

/**
 * POST /wasender/webhook
 */
router.post("/webhook", async (req, res) => {
  try {
    if (!verifySecret(req)) return res.status(403).send("Forbidden");

    const payload = req.body || {};

    if (isFromMe(payload)) return res.status(200).send("OK");

    const session = extractSession(payload); // (no es tu sessionId interno, es la instancia)
    const text = extractText(payload).trim();
    const fromRaw = extractFromRaw(payload);

    const phoneE164 = normalizePhoneToE164(fromRaw);
    if (!phoneE164) return res.status(200).send("OK");

    const media = extractMedia(payload);
    const profileName = extractProfileName(payload);

    // responder helper (Wasender)
    const send = async (textOut) => {
      await sendText({ toE164: phoneE164, text: String(textOut || "") });
    };

    // Empty message => menu
    const inboundText = text || "";
    if (!inboundText && (!media || media.count === 0)) {
      await send(menu());
      return res.status(200).json({ ok: true });
    }

    await handleInbound({
      inbound: {
        phoneE164,
        profileName,
        text: inboundText,
        media,
        raw: payload,
        providerSession: session
      },
      send
    });

    return res.status(200).json({ ok: true });
  } catch (err) {
    logger.error("Webhook error", err);
    // 200 para evitar loops de reintento del proveedor
    return res.status(200).send("OK");
  }
});

module.exports = router;