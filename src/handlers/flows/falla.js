// src/handlers/flows/falla.js
const { hasMinLen } = require("../../utils/validators");
const { createReport } = require("../../services/reportsService");
const { notifyAdmin } = require("../../services/notifyService");

function intro() {
  return (
    "Claro, te apoyo con la falla.\n" +
    "Para ubicarlo rápido: ¿estás *sin internet* o está *lento/intermitente*?"
  );
}

// Mensaje estilo “imagen 2” (resumido y leve)
function buildFallaResumenMsg({ folio }) {
  return (
    `✅ *Recibimos tu reporte*\n` +
    `Folio: *${folio}*\n\n` +
    `A partir de este momento se está trabajando\n` +
    `para restablecer tu servicio en un lapso de *24 a 48 hrs*.\n\n` +
    `⚠️ *Recomendaciones:*\n` +
    `1) Si no tiene internet, asegúrese que el módem esté conectado correctamente y con luz.\n` +
    `2) Si está bien conectado y aún no hay servicio, desconéctelo 30 segundos y vuelva a conectarlo.\n` +
    `3) Si no se restablece, envíe mensaje con su folio.\n` +
    `4) Por ningún motivo oprima el botón de *Reset* del router.\n\n` +
    `📲 Vía WhatsApp: *(475) 958 2328*\n` +
    `🕘 De *Lunes a Sábado* 8:30am a 8:30pm`
  );
}

async function handle({ session, inbound, send, updateSession, closeSession }) {
  const step = Number(session.step || 1);
  const data = session.data || {};
  const txt = String(inbound.text || "").trim();

  if (step === 1) {
    // Acepta respuesta libre, pero si es muy corta pide dato clave
    if (!hasMinLen(txt, 2)) {
      await send("¿Me confirmas si estás *sin internet* o está *lento/intermitente*?");
      return;
    }

    // Guardamos tipo (opcional)
    const tipo =
      /(sin internet|no hay internet|no tengo internet)/i.test(txt)
        ? "SIN_INTERNET"
        : /(lento|intermit|se va|se corta)/i.test(txt)
        ? "LENTO_INTERMITENTE"
        : "OTRO";

    await updateSession({ step: 2, data: { ...data, tipo } });

    await send("Perfecto. ¿A nombre de quién está el servicio?");
    return;
  }

  if (step === 2) {
    if (!hasMinLen(txt, 3)) {
      await send("¿A nombre de quién está el servicio?");
      return;
    }

    await updateSession({ step: 3, data: { ...data, nombre: txt } });

    await send("Gracias. Cuéntame qué pasa y desde cuándo (una frase está bien).");
    return;
  }

  if (step === 3) {
    if (!hasMinLen(txt, 5)) {
      await send("Dime un poquito más: ¿qué pasa exactamente y desde cuándo?");
      return;
    }

    const r = await createReport({
      phoneE164: session.phone_e164,
      nombre: data.nombre,
      descripcion: txt
    });

    await notifyAdmin(
      `🛠️ REPORTE DE FALLA ${r.folio}\n` +
        `Nombre: ${r.nombre}\n` +
        `Tel: ${session.phone_e164}\n` +
        `Tipo: ${data.tipo || "N/A"}\n` +
        `Descripción: ${r.descripcion}`
    );

    // Cierra sesión y manda el mensaje estilo “imagen 2”
    await closeSession(session.session_id);
    await send(buildFallaResumenMsg({ folio: r.folio }));
    return;
  }

  await closeSession(session.session_id);
  await send("Listo ✅ Si necesitas algo más, aquí estoy.");
}

module.exports = { intro, handle };