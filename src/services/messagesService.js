// src/services/messagesService.js
const { query } = require("../db");

/**
 * Inserta un mensaje WA.
 * - Idempotente por provider_msg_id (si viene).
 * - Si llega duplicado, regresa { duplicated: true } sin tronar.
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
  const sql = `
    insert into wa_messages
      (session_id, phone_e164, direction, body, media, raw, provider_msg_id)
    values
      ($1,$2,$3,$4,$5,$6,$7)
    on conflict (provider_msg_id) do nothing
    returning id, created_at
  `;

  const params = [
    sessionId || null,
    phoneE164,
    direction,
    body || null,
    media ? JSON.stringify(media) : null,
    raw ? JSON.stringify(raw) : null,
    providerMsgId || null
  ];

  // Si providerMsgId es NULL, "on conflict(provider_msg_id)" NO aplica.
  // Solución: si providerMsgId viene null, hacemos insert normal.
  if (!providerMsgId) {
    const r = await query(
      `
      insert into wa_messages (session_id, phone_e164, direction, body, media, raw, provider_msg_id)
      values ($1,$2,$3,$4,$5,$6,$7)
      returning id, created_at
      `,
      params
    );
    return { ...r.rows[0], duplicated: false };
  }

  const r = await query(sql, params);

  // Si fue duplicado, returning viene vacío
  if (!r.rows[0]) {
    return { id: null, created_at: null, duplicated: true };
  }

  return { ...r.rows[0], duplicated: false };
}

module.exports = { insertWaMessage };