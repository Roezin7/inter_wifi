const { hasMinLen, hasMediaUrls } = require("../../utils/validators");
const { extractFirstNumber } = require("../../utils/textUtils");
const { createPayment } = require("../../services/paymentsService");
const { notifyAdmin } = require("../../services/notifyService");
const { parsePaymentMesMonto } = require("../../services/llmService");

function intro() {
  return (
    "Claro ✅ Vamos a registrar tu pago.\n\n" +
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
    await send("2) ¿De qué *mes* es el pago y de cuánto fue? (ej: Enero 500)");
    return;
  }

  if (step === 2) {
    if (!hasMinLen(inbound.text, 3)) {
      await send("Ponme el *mes* y el *monto* (ej: Enero 500) 🙂");
      return;
    }

    const parsed = await parsePaymentMesMonto(inbound.text);
const mes = parsed.mes;
const monto = parsed.monto;

    if (!monto) {
      await send("No alcancé a ver el *monto* 😅 Ponlo así: *Enero 500*");
      return;
    }

    await updateSession({ step: 3, data: { ...data, mes, monto } });
    await send("3) Envíame el *comprobante* (foto o PDF) 📎");
    return;
  }

  if (step === 3) {
    if (!hasMediaUrls(inbound.media)) {
      await send("Necesito el *comprobante* (foto/PDF) 📎");
      return;
    }

    const url = inbound.media.urls[0];
    const finalData = { ...data, comprobante_url: url };

    const p = await createPayment({
      phoneE164: session.phone_e164,
      nombre: finalData.nombre,
      mes: finalData.mes,
      monto: finalData.monto,
      comprobante_url: finalData.comprobante_url
    });

    await notifyAdmin(
      `💵 PAGO REGISTRADO ${p.folio}\n` +
        `Nombre: ${p.nombre}\n` +
        `Mes: ${p.mes}\n` +
        `Monto: ${p.monto}\n` +
        `Comprobante: ${p.comprobante_url}`
    );

    await closeSession(session.session_id);
    await send(`¡Gracias! ✅ Pago registrado.\nFolio: *${p.folio}*`);
    return;
  }

  await closeSession(session.session_id);
  await send("Listo ✅");
}

module.exports = { intro, handle };