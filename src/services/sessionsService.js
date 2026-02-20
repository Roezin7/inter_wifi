const { query } = require("../db");

function newSessionId(phoneE164) {
  const t = Date.now();
  return `sess_${phoneE164.replace(/\D/g, "")}_${t}`;
}

async function getOpenSessionByPhone(phoneE164) {
  const r = await query(
    `select * from wa_sessions
     where phone_e164 = $1 and status = 'OPEN'
     order by created_at desc
     limit 1`,
    [phoneE164]
  );
  return r.rows[0] || null;
}

async function createSession({ phoneE164, flow, step = 1, data = {} }) {
  const sessionId = newSessionId(phoneE164);
  const r = await query(
    `insert into wa_sessions (session_id, phone_e164, flow, step, data)
     values ($1,$2,$3,$4,$5)
     returning *`,
    [sessionId, phoneE164, flow, step, JSON.stringify(data)]
  );
  return r.rows[0];
}

/**
 * Lock de sesión (evita race si llegan mensajes seguidos)
 */
async function lockSession(sessionId) {
  const r = await query(
    `select * from wa_sessions where session_id=$1 for update`,
    [sessionId]
  );
  return r.rows[0] || null;
}

async function updateSession({ sessionId, step, data }) {
  const r = await query(
    `update wa_sessions
     set step = coalesce($2, step),
         data = coalesce($3::jsonb, data),
         updated_at = now()
     where session_id = $1
     returning *`,
    [sessionId, step ?? null, data ? JSON.stringify(data) : null]
  );
  return r.rows[0] || null;
}

async function closeSession(sessionId) {
  const r = await query(
    `update wa_sessions
     set status='CLOSED', updated_at=now()
     where session_id=$1
     returning *`,
    [sessionId]
  );
  return r.rows[0] || null;
}

module.exports = {
  getOpenSessionByPhone,
  createSession,
  lockSession,
  updateSession,
  closeSession
};