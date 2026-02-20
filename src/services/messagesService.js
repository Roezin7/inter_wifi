// src/services/messagesService.js
const { query } = require("../db");

/**
 * Inserta un mensaje en wa_messages.
 * Si viene providerMsgId y ya existe, NO duplica (anti-loop).
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
  const q = `
    INSERT INTO wa_messages
      (session_id, phone_e164, direction, body, media, raw, provider_msg_id)
    VALUES
      ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (provider_msg_id) DO NOTHING
    RETURNING id, created_at
  `;

  const params = [
    sessionId || null,
    phoneE164,
    direction,
    body ?? null,
    media ? JSON.stringify(media) : null,
    raw ? JSON.stringify(raw) : null,
    providerMsgId ? String(providerMsgId) : null
  ];

  try {
    const r = await query(q, params);
    return r.rows[0] || null; // null = ya existía -> dedupe
  } catch (e) {
    // Si providerMsgId es null, ON CONFLICT no aplica; esto debe funcionar normal.
    // Si falla por otra razón, re-lanza.
    throw e;
  }
}

module.exports = { insertWaMessage };