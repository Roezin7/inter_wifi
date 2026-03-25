const { sendText } = require("./wasenderService");
const { normalizeMX10ToE164 } = require("../utils/validators");
const { logger } = require("../utils/logger");

function getAdminE164() {
  const raw = String(process.env.ADMIN_PHONE_E164 || "").trim();

  if (!raw) return null;

  // Si ya viene en +52..., úsalo
  if (/^\+\d{10,15}$/.test(raw)) return raw;

  // Si alguien guardó "4491234567" por error
  if (/^\d{10}$/.test(raw)) return normalizeMX10ToE164(raw);

  // Si guardaron "52xxxxxxxxxx" sin "+"
  if (/^52\d{10}$/.test(raw)) return `+${raw}`;

  return raw; // última opción, pero lo loguearemos
}

async function notifyAdmin(text) {
  const admin = getAdminE164();
  const msg = String(text || "").trim();

  if (!admin) {
    logger.warn("[ADMIN_NOTIFY] missing ADMIN_PHONE_E164");
    return { ok: false, skipped: true, reason: "missing_admin_phone" };
  }
  if (!msg) return { ok: true, skipped: true };

  try {
    const res = await sendText({ toE164: admin, text: msg });
    logger.info("[ADMIN_NOTIFY] sent", { admin, ok: res?.ok });
    return res;
  } catch (err) {
    logger.error("[ADMIN_NOTIFY] failed", {
      admin,
      error: err?.message || String(err),
    });
    return { ok: false, skipped: false, reason: "send_failed" };
  }
}

function buildNewContractAdminMsg(c) {
  return (
    "📥 *Nueva solicitud de contratación*\n" +
    `Folio: *${c.folio}*\n` +
    `Nombre: ${c.nombre}\n` +
    `Colonia: ${c.colonia}\n` +
    `Cobertura: ${c.cobertura || "POR VALIDAR"}\n` +
    (c.zona ? `Zona: ${c.zona}\n` : "") +
    `Dirección: ${c.calle_numero}\n` +
    `Tel: ${c.telefono_contacto}\n` +
    `Cliente WA: ${c.phone_e164}\n` +
    (c.ine_frente_url ? `INE Frente: ${c.ine_frente_url}\n` : "") +
    (c.ine_reverso_url ? `INE Atrás: ${c.ine_reverso_url}\n` : "")
  );
}

function buildAddressChangeAdminMsg(data) {
  return (
    "🏠 *Solicitud de cambio de domicilio*\n" +
    `Titular: ${data.nombre || "N/A"}\n` +
    `Domicilio actual: ${data.domicilio_actual || "N/A"}\n` +
    `Nuevo domicilio: ${data.nuevo_domicilio || "N/A"}\n` +
    `Tel: ${data.telefono_contacto || "N/A"}\n` +
    `Cliente WA: ${data.phone_e164 || "N/A"}`
  );
}

function buildPasswordChangeAdminMsg(data) {
  return (
    "🔐 *Solicitud de cambio de contraseña*\n" +
    `Titular: ${data.nombre || "N/A"}\n` +
    `Domicilio actual: ${data.domicilio_actual || "N/A"}\n` +
    `Tel: ${data.telefono_contacto || "N/A"}\n` +
    `Cliente WA: ${data.phone_e164 || "N/A"}`
  );
}

module.exports = {
  notifyAdmin,
  buildNewContractAdminMsg,
  buildAddressChangeAdminMsg,
  buildPasswordChangeAdminMsg,
};
