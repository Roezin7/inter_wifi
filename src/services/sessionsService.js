// src/services/sessionsService.js
const { pool } = require("../db");

// helper: usa client si te lo pasan; si no, usa pool (sin tx)
function q(client, text, params) {
  return (client || pool).query(text, params);
}

async function getOpenSessionByPhone(phoneE164, client = null) {
  const { rows } = await q(
    client,
    `select session_id, phone_e164, flow, step, data, status
     from wa_sessions
     where phone_e164=$1 and status='OPEN'
     order by updated_at desc nulls last, created_at desc nulls last
     limit 1`,
    [phoneE164]
  );
  return rows[0] || null;
}

/**
 * Crea sesión OPEN garantizando 1 por teléfono.
 * - Si ya hay OPEN, la reutiliza (actualiza flow/step/data)
 * - Si no hay, inserta nueva
 *
 * Importante: esto funciona perfecto si el caller está en TX
 * y usas el mismo client.
 */
async function createSession({ phoneE164, flow, step = 1, data = {} }, client = null) {
  // Bloqueo por teléfono (evita carreras aunque entren 2 webhooks a la vez)
  await q(client, `select pg_advisory_xact_lock(hashtext($1))`, [phoneE164]);

  const existing = await getOpenSessionByPhone(phoneE164, client);

  if (existing) {
    const { rows } = await q(
      client,
      `update wa_sessions
       set flow=$2, step=$3, data=$4, updated_at=now()
       where session_id=$1
       returning session_id, phone_e164, flow, step, data, status`,
      [existing.session_id, flow, step, JSON.stringify(data)]
    );
    return rows[0];
  }

  const sessionId = `sess_${phoneE164.replace("+", "")}_${Date.now()}`;

  const { rows } = await q(
    client,
    `insert into wa_sessions (session_id, phone_e164, flow, step, data, status)
     values ($1,$2,$3,$4,$5,'OPEN')
     returning session_id, phone_e164, flow, step, data, status`,
    [sessionId, phoneE164, flow, step, JSON.stringify(data)]
  );

  return rows[0];
}

async function updateSession({ sessionId, step, data }, client = null) {
  // OJO: NO “borres” data si viene undefined/null
  const hasData = data !== undefined && data !== null;

  const { rows } = await q(
    client,
    `
    update wa_sessions
    set step = $2,
        data = case when $3::boolean then $4::jsonb else data end,
        updated_at = now()
    where session_id = $1
    returning session_id, phone_e164, flow, step, data, status
    `,
    [sessionId, step, hasData, JSON.stringify(data || {})]
  );

  return rows[0] || null;
}

async function closeSession(sessionId, client = null) {
  await q(
    client,
    `update wa_sessions
     set status='CLOSED', closed_at=now(), updated_at=now()
     where session_id=$1`,
    [sessionId]
  );
}

async function lockSession(sessionId, client) {
  if (!client) throw new Error("lockSession requires a tx client");
  const { rows } = await q(
    client,
    `select session_id, phone_e164, flow, step, data, status
     from wa_sessions
     where session_id=$1 and status='OPEN'
     for update`,
    [sessionId]
  );
  return rows[0] || null;
}

module.exports = {
  getOpenSessionByPhone,
  createSession,
  updateSession,
  closeSession,
  lockSession
};