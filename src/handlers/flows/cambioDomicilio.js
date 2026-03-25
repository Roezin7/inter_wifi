const {
  hasMinLen,
  looksLikePhone10MX,
  normalizeMX10ToE164,
} = require("../../utils/validators");
const { parsePhoneE164 } = require("../../services/llmService");
const {
  notifyAdmin,
  buildAddressChangeAdminMsg,
} = require("../../services/notifyService");
const { introPair, nextPair, closePair } = require("../../utils/flowCopy");

function intro() {
  return introPair("cambio_domicilio", "Para empezar, compárteme el *nombre completo del titular*.");
}

async function resolvePhone(raw, fallbackE164) {
  const text = String(raw || "").trim();
  if (!text) return null;

  if (text.toLowerCase().includes("mismo")) return fallbackE164 || null;
  if (looksLikePhone10MX(text)) return normalizeMX10ToE164(text);

  try {
    const parsed = await parsePhoneE164(text, fallbackE164);
    return parsed?.phone_e164 || null;
  } catch {
    return null;
  }
}

async function handle({ session, inbound, send, updateSession, closeSession, notifyAdmin: notifyAdminFn }) {
  const step = Number(session.step || 1);
  const data = session.data || {};
  const text = String(inbound.text || "").trim();
  const phoneE164 = session.phone_e164 || inbound.phoneE164 || null;

  if (step === 1) {
    if (!hasMinLen(text, 3)) {
      await send("Necesito el *nombre completo del titular* para continuar 😊");
      return;
    }

    await updateSession({ step: 2, data: { ...data, nombre: text } });
    await send(nextPair("cambio_domicilio:actual", "Ahora compárteme el *domicilio actual* del servicio."));
    return;
  }

  if (step === 2) {
    if (!hasMinLen(text, 8)) {
      await send("Compárteme el *domicilio actual* con el mayor detalle posible 😊");
      return;
    }

    await updateSession({ step: 3, data: { ...data, domicilio_actual: text } });
    await send(nextPair("cambio_domicilio:nuevo", "Ahora compárteme el *nuevo domicilio*."));
    return;
  }

  if (step === 3) {
    if (!hasMinLen(text, 8)) {
      await send("Compárteme el *nuevo domicilio* con el mayor detalle posible 😊");
      return;
    }

    await updateSession({ step: 4, data: { ...data, nuevo_domicilio: text } });
    await send(nextPair("cambio_domicilio:phone", "¿Qué *teléfono de contacto* dejamos?\nPuedes escribir *mismo* si quieres usar este número."));
    return;
  }

  if (step === 4) {
    const telefono = await resolvePhone(text, phoneE164);
    if (!telefono) {
      await send("Compárteme un *teléfono de contacto* de 10 dígitos o escribe *mismo* 😊");
      return;
    }

    const payload = {
      ...data,
      telefono_contacto: telefono,
      phone_e164: phoneE164,
    };

    await (notifyAdminFn || notifyAdmin)(buildAddressChangeAdminMsg(payload));
    await closeSession(session.session_id);

    await send(
      closePair(
        "cambio_domicilio:done",
        "Ya registré tu solicitud de *cambio de domicilio*.\n\nUn asesor se comunicará contigo para continuar el proceso."
      )
    );
    return;
  }

  await closeSession(session.session_id);
  await send(closePair("cambio_domicilio:fallback", "Si necesitas algo más, aquí estoy 😊"));
}

module.exports = { intro, handle };
