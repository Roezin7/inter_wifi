const { sendText } = require("./wasenderService");

async function notifyAdmin(text) {
  const to = process.env.ADMIN_PHONE_E164;
  if (!to) return { ok: false, skipped: true };
  return sendText({ toE164: to, text });
}

module.exports = { notifyAdmin };