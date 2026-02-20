// src/services/messagesService.js
const { query } = require("../db");

async function insertWaMessage({ sessionId, phoneE164, direction, body, media, raw, providerMsgId }) {
  // Si NO hay providerMsgId (OUT), inserta normal
  if (!providerMsgId) {
    const r = await query(
      `insert into wa_messages (session_id, phone_e164, direction, body, media, raw)
       values ($1,$2,$3,$4,$5,$6)
       returning id, created_at`,
      [
        sessionId || null,
        phoneE164,
        direction,
        body || null,
        media ? JSON.stringify(media) : null,
        raw ? JSON.stringify(raw) : null
      ]
    );
    return r.rows[0];
  }

  // Si hay providerMsgId (IN), dedupe con ON CONFLICT
  const r = await query(
    `insert into wa_messages (session_id, phone_e164, direction, body, media, raw, provider_msg_id)
     values ($1,$2,$3,$4,$5,$6,$7)
     on conflict (provider_msg_id) do nothing
     returning id, created_at`,
    [
      sessionId || null,
      phoneE164,
      direction,
      body || null,
      media ? JSON.stringify(media) : null,
      raw ? JSON.stringify(raw) : null,
      String(providerMsgId)
    ]
  );

  // si rows.length === 0 => ya existía => RETRY => no respondas
  return r.rows[0] || null;
}

module.exports = { insertWaMessage };