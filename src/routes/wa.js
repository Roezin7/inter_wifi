const express = require("express");
const { sendText } = require("../services/wasenderService");
const { normalizeToE164 } = require("../utils/phoneUtils");
const { insertWaMessage } = require("../services/messagesService");

const router = express.Router();

router.post("/outbound", async (req, res) => {
  try {
    const { to_phone_e164, text } = req.body || {};
    if (!to_phone_e164 || !text) {
      return res.status(400).json({ ok: false, error: "missing_fields" });
    }

    const toE164 = normalizeToE164(to_phone_e164);
    if (!toE164) {
      return res.status(400).json({ ok: false, error: "invalid_to_phone" });
    }

    const providerResp = await sendText({ toE164, text: String(text) });

    await insertWaMessage({
      sessionId: null,
      phoneE164: toE164,
      direction: "OUT",
      body: String(text),
      raw: { wasender: providerResp }
    });

    return res.json({ ok: true, provider: providerResp });
  } catch (err) {
    console.error("Outbound error:", err);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

module.exports = router;