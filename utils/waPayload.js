const { normalizeToE164 } = require("./phoneUtils");
const { safeText } = require("./textUtils");

/**
 * Intenta soportar varios formatos comunes:
 * - payload.data.messages[0]
 * - payload.message
 * - payload.data.message
 * - payload.data (con fields directos)
 */

function pickFirstMessage(data) {
  if (!data) return null;
  if (Array.isArray(data.messages) && data.messages[0]) return data.messages[0];
  if (Array.isArray(data.data?.messages) && data.data.messages[0]) return data.data.messages[0];
  if (data.message) return data.message;
  if (data.data?.message) return data.data.message;
  return null;
}

function isFromMe(payload) {
  const data = payload?.data || payload;
  // algunos providers mandan fromMe boolean
  const m0 = pickFirstMessage(data);
  if (typeof m0?.fromMe === "boolean") return m0.fromMe;
  if (typeof data?.fromMe === "boolean") return data.fromMe;
  return false;
}

function extractSession(payload) {
  // Tu ruta vieja resolvía business por wa_instance (session)
  // Wasender suele mandar instance/session
  const data = payload?.data || payload;
  return (
    payload.session ||
    payload.instance ||
    data.session ||
    data.instance ||
    data.wa_instance ||
    null
  );
}

function extractText(payload) {
  const data = payload?.data || payload;
  const m0 = pickFirstMessage(data);
  const t =
    m0?.text?.body ||
    m0?.body ||
    m0?.text ||
    data.text ||
    data.body ||
    "";
  return safeText(t);
}

function extractFromRaw(payload) {
  const data = payload?.data || payload;
  const m0 = pickFirstMessage(data);

  const from =
    m0?.from ||
    m0?.author ||
    m0?.sender ||
    data.from ||
    data.author ||
    data.sender ||
    null;

  return from;
}

function extractProfileName(payload) {
  const data = payload?.data || payload;
  const m0 = pickFirstMessage(data);
  return data.profileName || m0?.pushName || m0?.profileName || null;
}

function extractMedia(payload) {
  const data = payload?.data || payload;
  const m0 = pickFirstMessage(data);

  // soporta: mediaUrl/mediaUrls, attachments, image, document, etc.
  const urls = [];

  const tryPush = (u) => {
    if (!u) return;
    if (Array.isArray(u)) u.forEach(tryPush);
    else urls.push(String(u));
  };

  tryPush(m0?.mediaUrl);
  tryPush(m0?.mediaUrls);
  tryPush(m0?.attachments?.map((a) => a?.url));
  tryPush(m0?.image?.url);
  tryPush(m0?.document?.url);

  return { count: urls.length, urls: urls.filter(Boolean) };
}

function normalizePhoneToE164(raw) {
  return normalizeToE164(raw);
}

module.exports = {
  pickFirstMessage,
  isFromMe,
  extractSession,
  extractText,
  extractFromRaw,
  extractProfileName,
  extractMedia,
  normalizePhoneToE164
};