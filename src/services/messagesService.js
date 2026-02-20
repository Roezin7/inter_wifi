// src/services/messagesService.js
const { query } = require("../db");

/**
 * Inserta mensaje IN/OUT de forma idempotente.
 * - Si provider_msg_id ya existe => NO duplica (evita loops por retries)
 * - Devuelve el registro existente o el nuevo
 */
async function insertWaMessage({
  sessionId,
  phoneE164,
  direction,
  body,
  media,
  raw,
  providerMsgId // <- NUEVO
}) {
  const provider = providerMsgId ? String(providerMsgId) : null;

  // INSERT idempotente
  const r = await query(
    `
    INSERT INTO wa_messages (session_id, phone_e164, direction, body, media, raw, provider_msg_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (provider_msg_id) DO NOTHING
    RETURNING id, created_at
    `,
    [
      sessionId || null,
      phoneE164,
      direction,
      body || null,
      media ? JSON.stringify(media) : null,
      raw ? JSON.stringify(raw) : null,
      provider
    ]
  );

  // Si fue duplicado, regresamos el existente
  if (r.rows.length === 0 && provider) {
    const e = await query(
      `SELECT id, created_at FROM wa_messages WHERE provider_msg_id = $1 LIMIT 1`,
      [provider]
    );
    return e.rows[0] || null;
  }

  return r.rows[0] || null;
}

module.exports = { insertWaMessage };