// src/services/messagesService.js
const { query } = require("../db");

/**
 * insertWaMessage idempotente por provider_msg_id:
 * - Si provider_msg_id existe y ya fue insertado => retorna null (corta retries/loops)
 * - Si provider_msg_id viene null => inserta normal
 */
async function insertWaMessage({
  sessionId,
  phoneE164,
  direction,
  body,
  media,
  raw,
  providerMsgId
}) {
  const mediaJson = media ? JSON.stringify(media) : null;
  const rawJson = raw ? JSON.stringify(raw) : null;
  const msgId = providerMsgId ? String(providerMsgId) : null;

  // Caso 1: sin msg id => no podemos dedupear, insert normal
  if (!msgId) {
    const r = await query(
      `insert into wa_messages (session_id, phone_e164, direction, body, media, raw)
       values ($1,$2,$3,$4,$5,$6)
       returning id, created_at`,
      [
        sessionId || null,
        phoneE164,
        direction,
        body || null,
        mediaJson,
        rawJson
      ]
    );
    return r.rows[0] || null;
  }

  // Caso 2: con msg id => idempotente por UNIQUE(provider_msg_id)
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
      mediaJson,
      rawJson,
      msgId
    ]
  );

  // si fue duplicado, rows viene vacío => null
  return r.rows[0] || null;
}

module.exports = { insertWaMessage };