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
      /(sin internet|no hay internet|no tengo internet)/i.test(txt) ? "SIN_INTERNET"
      : /(lento|intermit|se va|se corta)/i.test(txt) ? "LENTO_INTERMITENTE"
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

    await closeSession(session.session_id);
    await send(`Listo ✅ Ya quedó tu reporte.\nFolio: *${r.folio}*\n\nTe apoyamos en breve 🙌`);
    return;
  }

  await closeSession(session.session_id);
  await send("Listo ✅ Si necesitas algo más, aquí estoy.");
}

module.exports = { intro, handle };