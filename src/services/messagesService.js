// src/services/messagesService.js
const { query } = require("../db");

async function insertWaMessage({
  sessionId,
  phoneE164,
  direction,
  body,
  media,
  raw,
  providerMsgId
}) {
  // Si viene provider_msg_id y ya existe, NO insertamos de nuevo (dedupe)
  const r = await query(
    `INSERT INTO wa_messages
      (session_id, phone_e164, direction, body, media, raw, provider_msg_id)
     VALUES
      ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (provider_msg_id) DO NOTHING
     RETURNING id, created_at`,
    [
      sessionId || null,
      phoneE164,
      direction,
      body || null,
      media ? JSON.stringify(media) : null,
      raw ? JSON.stringify(raw) : null,
      providerMsgId ? String(providerMsgId) : null
    ]
  );

  // Si DO NOTHING, no hay rows, regresamos null
  return r.rows[0] || null;
}

module.exports = { insertWaMessage };