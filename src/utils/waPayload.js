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

/**
 * Quita sufijos típicos de WhatsApp:
 * - @s.whatsapp.net
 * - @c.us
 * - @g.us (grupos)
 * - @lid
 */
function stripJid(x) {
  const s = str(x).trim();
  if (!s) return "";
  return s
    .replace(/@s\.whatsapp\.net$/i, "")
    .replace(/@c\.us$/i, "")
    .replace(/@g\.us$/i, "")
    .replace(/@lid$/i, "");
}

/**
 * WasenderAPI real payload shape (from your logs):
 * payload.event = "messages.received"
 * payload.data.messages.key.cleanedSenderPn -> "5214499857444"
 * payload.data.messages.messageBody -> "hola"
 * payload.data.messages.message.conversation -> "hola"
 */
function isWasenderMessagesReceived(payload) {
  return !!payload && typeof payload === "object" && payload.event === "messages.received";
}

/**
 * Determina si el mensaje es fromMe (enviado por ti)
 */
function isFromMe(payload) {
  // Wasender real
  const a = payload?.data?.messages?.key?.fromMe;
  if (typeof a === "boolean") return a;

  // Algunos payloads alternos / legacy
  const b = payload?.data?.message?.key?.fromMe;
  if (typeof b === "boolean") return b;

  const c = payload?.data?.message?.fromMe;
  if (typeof c === "boolean") return c;

  return false;
}

/**
 * Session / instance id
 */
function extractSession(payload) {
  return pickFirst(payload?.sessionId, payload?.data?.sessionId, payload?.data?.instanceId);
}

/**
 * Nombre de perfil
 */
function extractProfileName(payload) {
  return pickFirst(payload?.data?.messages?.pushName, payload?.data?.message?.pushName);
}

/**
 * Extrae un “fromRaw” robusto:
 * preferimos cleanedSenderPn (es el número limpio)
 */
function extractFromRaw(payload) {
  // Wasender preferred:
  const cleaned =
    payload?.data?.messages?.key?.cleanedSenderPn ||
    payload?.data?.messages?.key?.senderPn ||
    payload?.data?.messages?.key?.remoteJid ||
    payload?.data?.messages?.remoteJid ||
    payload?.data?.messages?.key?.participant;

  // Legacy:
  const legacy =
    payload?.data?.message?.from ||
    payload?.data?.message?.key?.remoteJid ||
    payload?.data?.from ||
    payload?.from;

  return stripJid(pickFirst(cleaned, legacy));
}

/**
 * Extrae texto “humano” desde el payload
 */
function extractText(payload) {
  const msg = payload?.data?.messages;

  // 1) campo directo
  const direct = msg?.messageBody;

  // 2) contenedor message
  const m = msg?.message || {};
  const conversation = m?.conversation;

  // extended text
  const ext = m?.extendedTextMessage?.text;

  // botones/listas
  const btn =
    m?.buttonsResponseMessage?.selectedDisplayText ||
    m?.buttonsResponseMessage?.selectedButtonId;

  const list =
    m?.listResponseMessage?.title ||
    m?.listResponseMessage?.singleSelectReply?.selectedRowId;

  // legacy
  const legacy =
    payload?.data?.message?.text?.body ||
    payload?.data?.message?.body ||
    payload?.message;

  return pickFirst(direct, conversation, ext, btn, list, legacy);
}

/**
 * Media: intenta encontrar urls si existieran
 * (en tus logs todavía no venían, pero dejamos soporte)
 */
function extractMedia(payload) {
  const out = { urls: [], count: 0 };

  const m = payload?.data?.messages?.message || {};
  const urls = [];

  const maybeUrl = (x) => {
    const s = str(x).trim();
    if (/^https?:\/\//i.test(s)) urls.push(s);
  };

  // WhatsApp container types
  maybeUrl(m?.imageMessage?.url);
  maybeUrl(m?.videoMessage?.url);
  maybeUrl(m?.documentMessage?.url);
  maybeUrl(m?.audioMessage?.url);

  // A veces proveedores meten url directo en "messageBody"/"message"
  maybeUrl(payload?.data?.messages?.url);
  maybeUrl(payload?.data?.messages?.mediaUrl);

  out.urls = Array.from(new Set(urls));
  out.count = out.urls.length;
  return out;
}

/**
 * Normaliza cualquier fromRaw a E164.
 * - Si ya viene 52 + 10 dígitos => +52XXXXXXXXXX
 * - Si viene 10 dígitos => +52 + 10
 */
function normalizePhoneToE164(fromRaw) {
  const base = stripJid(fromRaw);
  const digits = base.replace(/[^\d]/g, "");
  if (!digits) return null;

  // 52 + 10 dígitos
  if (digits.length === 12 && digits.startsWith("52")) return `+${digits}`;

  // local 10
  if (digits.length === 10) return `+52${digits}`;

  // 11 (a veces) => agarrar últimos 10
  if (digits.length === 11) return `+52${digits.slice(-10)}`;

  // si viene muy largo, último 10
  if (digits.length > 12) return `+52${digits.slice(-10)}`;

  // fallback genérico
  if (digits.length >= 8) return `+${digits}`;

  return null;
}

/**
 * NUEVO: extrae provider_msg_id (para dedupe)
 * - Wasender real: payload.data.messages.key.id
 * - a veces: payload.data.messages.id
 * - legacy: payload.data.message.id
 */
function extractProviderMsgId(payload) {
  return pickFirst(
    payload?.data?.messages?.key?.id,
    payload?.data?.messages?.id,
    payload?.data?.message?.id,
    payload?.id
  );
}

module.exports = {
  isFromMe,
  extractSession,
  extractText,
  extractFromRaw,
  extractProfileName,
  extractMedia,
  normalizePhoneToE164,
  isWasenderMessagesReceived,
  extractProviderMsgId
};