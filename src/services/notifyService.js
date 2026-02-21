const { sendText } = require("./wasenderService");
const { normalizeMX10ToE164 } = require("../utils/validators");

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
    console.error("[ADMIN_NOTIFY] missing ADMIN_PHONE_E164");
    return { ok: false, skipped: true, reason: "missing_admin_phone" };
  }
  if (!msg) return { ok: true, skipped: true };

  try {
    const res = await sendText({ toE164: admin, text: msg });
    console.log("[ADMIN_NOTIFY] sent", { admin, ok: res?.ok });
    return res;
  } catch (err) {
    console.error("[ADMIN_NOTIFY] failed", {
      admin,
      error: err?.message || String(err),
    });
    throw err; // IMPORTANT: si quieres que no rompa el flow, cambia a "return {ok:false}"
  }
}

function buildNewContractAdminMsg(c) {
  // OJO: mantenlo CORTO para evitar fallos por tamaño.
  // No metas urls gigantes si no es necesario.
  return (
    "📥 *Nueva solicitud de contratación*\n" +
    `Folio: *${c.folio}*\n` +
    `Nombre: ${c.nombre}\n` +
    `Colonia: ${c.colonia}\n` +
    `Dirección: ${c.calle_numero}\n` +
    `Tel: ${c.telefono_contacto}\n` +
    `Cliente WA: ${c.phone_e164}\n`
  );
}

module.exports = { notifyAdmin, buildNewContractAdminMsg };