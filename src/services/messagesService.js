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
      providerMsgId ? String(providerMsgId) : null
    ]
  );

  // Si fue dedupe (do nothing), no retorna filas
  return r.rows[0] || null;
}

module.exports = { insertWaMessage };