// src/services/sessionsService.js
const { query } = require("../db");

function q(client) {
  return client ? client.query.bind(client) : query;
}

async function getOpenSessionByPhone(phoneE164, client = null) {
  const run = q(client);
  const { rows } = await run(
    `select session_id, phone_e164, flow, step, data, status
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
     returning session_id, phone_e164, flow, step, data, status`,
    [sessionId, phoneE164, flow, step, JSON.stringify(data)]
  );

  return rows[0] || null;
}

async function updateSession({ sessionId, step, data }, client = null) {
  const run = q(client);
  const { rows } = await run(
    `update wa_sessions
     set step=$2, data=$3, updated_at=now()
     where session_id=$1
     returning session_id, phone_e164, flow, step, data, status`,
    [sessionId, step, JSON.stringify(data || {})]
  );
  return rows[0] || null;
}

async function closeSession(sessionId, client = null) {
  const run = q(client);
  await run(
    `update wa_sessions
     set status='CLOSED', closed_at=now(), updated_at=now()
     where session_id=$1`,
    [sessionId]
  );
}

async function lockSession(sessionId, client = null) {
  const run = q(client);
  const { rows } = await run(
    `select session_id, phone_e164, flow, step, data, status
     from wa_sessions
     where session_id=$1 and status='OPEN'
     for update skip locked`,
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