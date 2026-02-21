// src/services/wasenderService.js
const axios = require("axios");

const WASENDER_BASE = process.env.WASENDER_BASE_URL; // ej: https://api.wasender.com (según tu proveedor)
const WASENDER_TOKEN = process.env.WASENDER_TOKEN;

const MIN_INTERVAL_MS = Number(process.env.WASENDER_MIN_INTERVAL_MS || 5200); // 5.2s seguro
const MAX_RETRIES = Number(process.env.WASENDER_MAX_RETRIES || 3);

// Cola por destinatario para no violar rate limit
const queues = new Map(); // toE164 -> Promise chain
const lastSentAt = new Map(); // toE164 -> timestamp

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function throttle(toE164) {
  const last = lastSentAt.get(toE164) || 0;
  const now = Date.now();
  const wait = Math.max(0, MIN_INTERVAL_MS - (now - last));
  if (wait > 0) await sleep(wait);
}

async function _sendTextOnce({ toE164, text }) {
  if (!WASENDER_BASE || !WASENDER_TOKEN) {
    throw new Error("WASENDER_BASE_URL / WASENDER_TOKEN missing");
  }

  // 👇 Ajusta el endpoint/body a tu API real
  const url = `${WASENDER_BASE}/send-message`;

  const res = await axios.post(
    url,
    { to: toE164, text },
    {
      headers: {
        Authorization: `Bearer ${WASENDER_TOKEN}`,
        "Content-Type": "application/json"
      },
      timeout: 20000
    }
  );

  return res.data;
}

async function sendText({ toE164, text }) {
  const msg = String(text || "").trim();
  if (!toE164 || !msg) return { ok: true, skipped: true };

  // Encadena por destinatario (serializa envíos)
  const prev = queues.get(toE164) || Promise.resolve();

  const task = prev
    .catch(() => {}) // si el anterior falló, no rompas la cola
    .then(async () => {
      // throttle duro
      await throttle(toE164);

      let attempt = 0;
      while (attempt <= MAX_RETRIES) {
        try {
          const out = await _sendTextOnce({ toE164, text: msg });
          lastSentAt.set(toE164, Date.now());
          return { ok: true, data: out };
        } catch (e) {
          const status = e?.response?.status;
          const body = e?.response?.data;
          const retryAfter =
            Number(body?.retry_after) ||
            Number(e?.response?.headers?.["retry-after"]) ||
            0;

          // ✅ Rate limit -> espera y reintenta
          if (status === 429 && attempt < MAX_RETRIES) {
            const waitMs = Math.max(1000, (retryAfter || 3) * 1000);
            await sleep(waitMs + 250); // colchón
            attempt++;
            continue;
          }

          // otro error o ya sin retries
          throw new Error(
            `Wasender send-message failed: ${status || "ERR"} ${JSON.stringify(body || e?.message || e)}`
          );
        }
      }
    })
    .finally(() => {
      // si esta task es la última, limpia
      if (queues.get(toE164) === task) queues.delete(toE164);
    });

  queues.set(toE164, task);
  return task;
}

module.exports = { sendText };