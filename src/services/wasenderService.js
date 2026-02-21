// src/services/wasenderService.js
const axios = require("axios");

const WASENDER_BASE_URL = process.env.WASENDER_BASE_URL; // ej: https://api.wasender.com
const WASENDER_TOKEN = process.env.WASENDER_TOKEN;

// Wasender: account protection => 1 msg / 5s
const MIN_INTERVAL_MS = Number(process.env.WASENDER_MIN_INTERVAL_MS || 5200);
const MAX_RETRIES_429 = Number(process.env.WASENDER_RETRY_429 || 2);

// last sent per recipient
const lastSentAt = new Map();

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function throttle(toE164) {
  const key = String(toE164 || "");
  const last = lastSentAt.get(key) || 0;
  const now = Date.now();
  const wait = MIN_INTERVAL_MS - (now - last);
  if (wait > 0) await sleep(wait);
  lastSentAt.set(key, Date.now());
}

// Extra: retry si Wasender responde 429 con retry_after
async function sendText({ toE164, text }) {
  const to = String(toE164 || "").trim();
  const body = String(text || "");

  if (!to) throw new Error("sendText: missing toE164");
  if (!body) return;

  // throttle por destinatario
  await throttle(to);

  let attempt = 0;

  while (true) {
    try {
      const res = await axios.post(
        `${WASENDER_BASE_URL}/send-message`,
        { to, text: body },
        { headers: { Authorization: `Bearer ${WASENDER_TOKEN}` }, timeout: 20000 }
      );
      return res.data;
    } catch (err) {
      const status = err?.response?.status;
      const data = err?.response?.data;

      // 429 protection
      if (status === 429 && attempt < MAX_RETRIES_429) {
        const retryAfterSec = Number(data?.retry_after ?? 3);
        await sleep(Math.max(1, retryAfterSec) * 1000);
        // importante: actualiza lastSentAt para no re-disparar demasiado rápido
        lastSentAt.set(to, Date.now());
        attempt++;
        continue;
      }

      const msg = `Wasender send-message failed: ${status || "?"} ${JSON.stringify(data || {})}`;
      const e = new Error(msg);
      e.cause = err;
      throw e;
    }
  }
}

module.exports = { sendText };