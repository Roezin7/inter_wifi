const { hasMinLen } = require("../../../utils/validators");
const { createReport } = require("../../services/reportsService");
const { notifyAdmin } = require("../../services/notifyService");

function intro() {
  return (
    "Lo siento 😕 Vamos a levantar tu reporte.\n\n" +
    "1) ¿A nombre de quién está el servicio?"
  );
}

async function handle({ session, inbound, send, updateSession, closeSession }) {
  const step = session.step || 1;
  const data = session.data || {};

  if (step === 1) {
    if (!hasMinLen(inbound.text, 3)) {
      await send("¿A nombre de quién está el servicio? 🙂");
      return;
    }
    await updateSession({ step: 2, data: { ...data, nombre: inbound.text.trim() } });
    await send("2) Describe la falla (¿qué pasa y desde cuándo?)");
    return;
  }

  if (step === 2) {
    if (!hasMinLen(inbound.text, 5)) {
      await send("Dime un poquito más de la falla (mínimo 1 frase) 🙂");
      return;
    }

    const r = await createReport({
      phoneE164: session.phone_e164,
      nombre: data.nombre,
      descripcion: inbound.text.trim()
    });

    await notifyAdmin(
      `🛠️ REPORTE DE FALLA ${r.folio}\n` +
        `Nombre: ${r.nombre}\n` +
        `Tel: ${session.phone_e164}\n` +
        `Descripción: ${r.descripcion}`
    );

    await closeSession(session.session_id);
    await send(`Listo ✅ Ya quedó tu reporte.\nFolio: *${r.folio}*\n\nTe apoyamos en breve 🙌`);
    return;
  }

  await closeSession(session.session_id);
  await send("Listo ✅");
}

module.exports = { intro, handle };