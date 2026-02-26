// src/services/sessionsService.js
const { query } = require("../db");

function q(client) {
  return client ? client.query.bind(client) : query;
}

async function getOpenSessionByPhone(phoneE164, client = null) {
  const run = q(client);
  const { rows } = await run(
    `select session_id, phone_e164, flow, step, data, status, updated_at
     from wa_sessions
     where phone_e164=$1 and status='OPEN'
     order by updated_at desc nulls last, created_at desc nulls last
     limit 1`,
    [phoneE164]
  );
  return rows[0] || null;
}

async function createSession({ phoneE164, flow, step = 1, data = {} }, client = null) {
  const run = q(client);

  // cierra cualquier OPEN anterior (hard reset)
  await run(
    `update wa_sessions
     set status='CLOSED', closed_at=now(), updated_at=now()
     where phone_e164=$1 and status='OPEN'`,
    [phoneE164]
  );

  const sessionId = `sess_${phoneE164.replace("+", "")}_${Date.now()}`;

  const { rows } = await run(
    `insert into wa_sessions (session_id, phone_e164, flow, step, data, status)
     values ($1,$2,$3,$4,$5,'OPEN')
     returning session_id, phone_e164, flow, step, data, status, updated_at`,
    [sessionId, phoneE164, flow, step, JSON.stringify(data)]
  );

  return rows[0];
}

async function updateSession({ sessionId, step, data }, client = null) {
  const run = q(client);
  const { rows } = await run(
    `update wa_sessions
     set step=$2, data=$3, updated_at=now()
     where session_id=$1
     returning session_id, phone_e164, flow, step, data, status, updated_at`,
    [sessionId, step, JSON.stringify(data || {})]
  );
  return rows[0] || null;
}

async function closeSession(sessionId, client = null, reason = null) {
  const run = q(client);
  await run(
    `update wa_sessions
     set status='CLOSED', closed_at=now(), updated_at=now(),
         data = case
           when $2::text is null then data
           else jsonb_set(coalesce(data,'{}'::jsonb), '{close_reason}', to_jsonb($2::text), true)
         end
     where session_id=$1`,
    [sessionId, reason]
  );
}

async function lockSession(sessionId, client = null) {
  const run = q(client);
  const { rows } = await run(
    `select session_id, phone_e164, flow, step, data, status, updated_at
     from wa_sessions
     where session_id=$1 and status='OPEN'
     for update`,
    [sessionId]
  );
  return rows[0] || null;
}

/**
 * Si la sesión está inactiva N minutos, la cierra (timeout)
 * Retorna true si cerró, false si no.
 */
async function closeIfTimedOut(session, timeoutMinutes, client = null) {
  if (!session?.updated_at) return false;
  const last = new Date(session.updated_at).getTime();
  const now = Date.now();
  const diffMin = (now - last) / (1000 * 60);
  if (diffMin >= timeoutMinutes) {
    await closeSession(session.session_id, client, "timeout");
    return true;
  }
  return false;
}

module.exports = {
  getOpenSessionByPhone,
  createSession,
  updateSession,
  closeSession,
  lockSession,
  closeIfTimedOut,
};