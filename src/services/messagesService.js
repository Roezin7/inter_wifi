const { query } = require("../db");

async function insertWaMessage({ sessionId, phoneE164, direction, body, media, raw }) {
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

module.exports = { insertWaMessage };