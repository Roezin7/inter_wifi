// src/services/wasenderService.js
const axios = require("axios");

const WASENDER_BASE = (process.env.WASENDER_BASE_URL || "").replace(/\/+$/, "");
const WASENDER_TOKEN = process.env.WASENDER_TOKEN;

// Límite que te mostró Wasender: 1 msg / 5s. Pon 5200ms por colchón.
const MIN_INTERVAL_MS = Number(process.env.WASENDER_MIN_INTERVAL_MS || 5200);
const MAX_RETRIES = Number(process.env.WASENDER_MAX_RETRIES || 3);

// ✅ Cola GLOBAL (rate limit es por cuenta/sesión, no por destinatario)
let globalQueue = Promise.resolve();
let lastSentAt = 0;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function throttleGlobal() {
  const now = Date.now();
  const wait = Math.max(0, MIN_INTERVAL_MS - (now - lastSentAt));
  if (wait > 0) await sleep(wait);
}

function looksLikeHtml(data) {
  if (!data) return false;
  const s = typeof data === "string" ? data : JSON.stringify(data);
  return /<!doctype html>|<html/i.test(s);
}

function pickErrBody(err) {
  const data = err?.response?.data;
  if (typeof data === "string") return data.slice(0, 500);
  try {
    return JSON.stringify(data).slice(0, 500);
  } catch {
    return String(data).slice(0, 500);
  }
}

function ensureConfig() {
  if (!WASENDER_BASE || !WASENDER_TOKEN) {
    throw new Error("WASENDER_BASE_URL / WASENDER_TOKEN missing");
  }
}

function buildHeaders() {
  return {
    Authorization: `Bearer ${WASENDER_TOKEN}`,
    "Content-Type": "application/json",
  };
}

// ✅ Texto: POST /api/send-message { to, text }
async function _sendTextOnce({ toE164, text }) {
  ensureConfig();

  const url = `${WASENDER_BASE}/api/send-message`;

  const res = await axios.post(
    url,
    { to: String(toE164), text: String(text || "") },
    {
      headers: buildHeaders(),
      timeout: 20000,
      validateStatus: () => true,
    }
  );

  if (res.status < 200 || res.status >= 300) {
    if (looksLikeHtml(res.data)) {
      throw new Error(
        `Wasender returned HTML (likely wrong endpoint). ` +
          `Check WASENDER_BASE_URL and use /api/send-message. status=${res.status}`
      );
    }

    const retryAfter =
      Number(res.data?.retry_after) || Number(res.headers?.["retry-after"]) || 0;

    const e = new Error(
      `Wasender send-message(text) failed: ${res.status} ${
        typeof res.data === "string" ? res.data.slice(0, 300) : JSON.stringify(res.data)
      }`
    );
    e.status = res.status;
    e.retryAfter = retryAfter;
    e.body = res.data;
    throw e;
  }

  return res.data;
}

// ✅ Imagen: POST /api/send-message { to, text?, imageUrl }
async function _sendImageOnce({ toE164, url, caption }) {
  ensureConfig();

  const endpoint = `${WASENDER_BASE}/api/send-message`;

  const res = await axios.post(
    endpoint,
    {
      to: String(toE164),
      text: String(caption || ""),
      imageUrl: String(url),
    },
    {
      headers: buildHeaders(),
      timeout: 30000,
      validateStatus: () => true,
    }
  );

  if (res.status < 200 || res.status >= 300) {
    if (looksLikeHtml(res.data)) {
      throw new Error(
        `Wasender returned HTML (likely wrong endpoint). ` +
          `Check WASENDER_BASE_URL and use /api/send-message. status=${res.status}`
      );
    }

    const retryAfter =
      Number(res.data?.retry_after) || Number(res.headers?.["retry-after"]) || 0;

    const e = new Error(
      `Wasender send-message(image) failed: ${res.status} ${
        typeof res.data === "string" ? res.data.slice(0, 300) : JSON.stringify(res.data)
      }`
    );
    e.status = res.status;
    e.retryAfter = retryAfter;
    e.body = res.data;
    throw e;
  }

  return res.data;
}

async function sendText({ toE164, text }) {
  const msg = String(text || "").trim();
  if (!toE164 || !msg) return { ok: true, skipped: true };

  globalQueue = globalQueue
    .catch(() => {})
    .then(async () => {
      await throttleGlobal();

      let attempt = 0;
      while (attempt <= MAX_RETRIES) {
        try {
          const out = await _sendTextOnce({ toE164, text: msg });
          lastSentAt = Date.now();
          return { ok: true, data: out };
        } catch (err) {
          const status = err?.status || err?.response?.status;
          const retryAfter =
            Number(err?.retryAfter) ||
            Number(err?.response?.data?.retry_after) ||
            Number(err?.response?.headers?.["retry-after"]) ||
            0;

          if (status === 429 && attempt < MAX_RETRIES) {
            const waitMs = Math.max(1000, (retryAfter || 5) * 1000);
            await sleep(waitMs + 250);
            attempt++;
            continue;
          }

          const body = pickErrBody(err);
          throw new Error(`Wasender send-message(text) failed: ${status || "ERR"} body=${body}`);
        }
      }
    });

  return globalQueue;
}

async function sendImage({ toE164, url, caption = "" }) {
  const imgUrl = String(url || "").trim();
  const cap = String(caption || "").trim();

  if (!toE164 || !imgUrl) return { ok: true, skipped: true };

  globalQueue = globalQueue
    .catch(() => {})
    .then(async () => {
      await throttleGlobal();

      let attempt = 0;
      while (attempt <= MAX_RETRIES) {
        try {
          const out = await _sendImageOnce({ toE164, url: imgUrl, caption: cap });
          lastSentAt = Date.now();
          return { ok: true, data: out };
        } catch (err) {
          const status = err?.status || err?.response?.status;
          const retryAfter =
            Number(err?.retryAfter) ||
            Number(err?.response?.data?.retry_after) ||
            Number(err?.response?.headers?.["retry-after"]) ||
            0;

          if (status === 429 && attempt < MAX_RETRIES) {
            const waitMs = Math.max(1000, (retryAfter || 5) * 1000);
            await sleep(waitMs + 250);
            attempt++;
            continue;
          }

          const body = pickErrBody(err);
          throw new Error(`Wasender send-message(image) failed: ${status || "ERR"} body=${body}`);
        }
      }
    });

  return globalQueue;
}

module.exports = { sendText, sendImage };