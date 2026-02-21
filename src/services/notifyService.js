// src/services/notifyService.js
const { sendText } = require("./wasenderService");

const ADMIN_E164 = process.env.ADMIN_E164; // +52...

function safe(s) {
  return String(s || "").trim();
}

function labelLine(label, value) {
  const v = safe(value);
  return v ? `*${label}:* ${v}` : `*${label}:* —`;
}

function linkLine(label, url) {
  const u = safe(url);
  if (!u) return `*${label}:* —`;
  // WhatsApp no permite "texto con link" real, pero así se ve ordenado
  return `*${label}:*\n${u}`;
}

async function notifyAdmin(text) {
  if (!ADMIN_E164) return;
  await sendText({ toE164: ADMIN_E164, text });
}

function buildNewContractAdminMsg(c) {
  return (
    `📩 *NUEVO CONTRATO* ✅\n` +
    `🧾 *Folio:* ${safe(c.folio)}\n\n` +
    `${labelLine("Nombre", c.nombre)}\n` +
    `${labelLine("Tel", c.telefono_contacto)}\n` +
    `${labelLine("Colonia", c.colonia)}\n` +
    `${labelLine("Dirección", c.calle_numero)}\n\n` +
    `${linkLine("INE (frente)", c.ine_frente_url)}\n\n` +
    `${linkLine("INE (atrás)", c.ine_reverso_url)}\n\n` +
    `⚠️ *Nota:* Si el link se ve “.enc” o expira, pide que reenvíen la imagen por este chat.`
  );
}

module.exports = { notifyAdmin, buildNewContractAdminMsg };