// src/utils/waPayload.js

function str(x) {
  return typeof x === "string" ? x : x == null ? "" : String(x);
}

function pickFirst(...vals) {
  for (const v of vals) {
    if (v === undefined || v === null) continue;
    const s = str(v).trim();
    if (s) return s;
  }
  return "";
}

function stripJid(x) {
  const s = str(x).trim();
  if (!s) return "";
  // "521...@s.whatsapp.net" -> "521..."
  return s.replace(/@s\.whatsapp\.net$/i, "").replace(/@lid$/i, "");
}

/**
 * WasenderAPI real payload shape (from your logs):
 * payload.data.messages.key.cleanedSenderPn -> "5214499857444"
 * payload.data.messages.messageBody -> "hola"
 * payload.data.messages.message.conversation -> "hola"
 */
function isWasenderMessagesReceived(payload) {
  return !!payload && typeof payload === "object" && payload.event === "messages.received";
}

function isFromMe(payload) {
  // Primary: WasenderAPI shape
  const fromMe =
    payload?.data?.messages?.key?.fromMe ??
    payload?.data?.message?.fromMe ??
    payload?.data?.message?.fromMe;

  return Boolean(fromMe);
}

function extractSession(payload) {
  // WasenderAPI uses sessionId at root
  return pickFirst(payload?.sessionId, payload?.data?.sessionId, payload?.data?.instanceId);
}

function extractProfileName(payload) {
  // WasenderAPI: pushName
  return pickFirst(payload?.data?.messages?.pushName, payload?.data?.message?.pushName);
}

function extractFromRaw(payload) {
  // WasenderAPI preferred:
  const cleaned =
    payload?.data?.messages?.key?.cleanedSenderPn ||
    payload?.data?.messages?.key?.senderPn ||
    payload?.data?.messages?.key?.remoteJid ||
    payload?.data?.messages?.remoteJid ||
    payload?.data?.messages?.key?.participant;

  // Backward compatibility with older test payloads you used
  const legacy =
    payload?.data?.message?.from ||
    payload?.data?.message?.key?.remoteJid ||
    payload?.data?.from ||
    payload?.from;

  return stripJid(pickFirst(cleaned, legacy));
}

function extractText(payload) {
  // WasenderAPI:
  const msg = payload?.data?.messages;

  // 1) direct convenience field
  const direct = msg?.messageBody;

  // 2) common WhatsApp message container
  const m = msg?.message || {};

  const conversation = m?.conversation;

  // extended text
  const ext = m?.extendedTextMessage?.text;

  // buttons/list replies
  const btn = m?.buttonsResponseMessage?.selectedDisplayText || m?.buttonsResponseMessage?.selectedButtonId;
  const list = m?.listResponseMessage?.title || m?.listResponseMessage?.singleSelectReply?.selectedRowId;

  // fallback older mock
  const legacy = payload?.data?.message?.text?.body || payload?.data?.message?.body || payload?.message;

  return pickFirst(direct, conversation, ext, btn, list, legacy);
}

function extractMedia(payload) {
  // Default: none
  const out = { urls: [], count: 0 };

  const msg = payload?.data?.messages?.message || {};
  // Check common media types
  const img = msg?.imageMessage;
  const video = msg?.videoMessage;
  const doc = msg?.documentMessage;
  const audio = msg?.audioMessage;

  // Wasender sometimes provides direct URLs in other fields, but in your payload we didn't see urls.
  // Keep it future-proof:
  const urls = [];

  const maybeUrl = (x) => {
    const s = str(x).trim();
    if (/^https?:\/\//i.test(s)) urls.push(s);
  };

  // try a few common fields
  maybeUrl(img?.url);
  maybeUrl(video?.url);
  maybeUrl(doc?.url);
  maybeUrl(audio?.url);

  out.urls = Array.from(new Set(urls));
  out.count = out.urls.length;
  return out;
}

function normalizePhoneToE164(fromRaw) {
  const digits = stripJid(fromRaw).replace(/[^\d]/g, "");
  if (!digits) return null;

  // If already starts with country code (52...), keep it
  if (digits.length === 12 && digits.startsWith("52")) return `+${digits}`;

  // Mexico local 10 digits => +52
  if (digits.length === 10) return `+52${digits}`;

  // If 11 digits and starts with 1 (some formats), try +52 last 10
  if (digits.length === 11) return `+52${digits.slice(-10)}`;

  // last resort: if longer, take last 10 and assume MX
  if (digits.length > 12) return `+52${digits.slice(-10)}`;

  // otherwise, return as generic +<digits>
  if (digits.length >= 8) return `+${digits}`;

  return null;
}

module.exports = {
  isFromMe,
  extractSession,
  extractText,
  extractFromRaw,
  extractProfileName,
  extractMedia,
  normalizePhoneToE164,
  isWasenderMessagesReceived
};