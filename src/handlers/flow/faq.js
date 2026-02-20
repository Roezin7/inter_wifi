const { matchFaq } = require("../../services/faqService");

function intro() {
  return (
    "¡Claro! 🙂\n" +
    "Dime tu duda (horarios, precios, ubicación, etc.)"
  );
}

async function handle({ session, inbound, send, closeSession }) {
  const threshold = Number(process.env.FAQ_MATCH_THRESHOLD || 0.7);

  const m = await matchFaq(inbound.text, threshold);
  if (m.matched) {
    await send(m.faq.answer);
    await closeSession(session.session_id);
    return;
  }

  // fallback sin LLM: respuesta genérica útil
  await send(
    "Te ayudo con eso 🙂\n" +
      "¿Tu duda es sobre:\n" +
      "1) Contratar servicio\n" +
      "2) Reportar falla\n" +
      "3) Registrar pago\n" +
      "4) Horarios/ubicación/precios\n\n" +
      "Respóndeme con el número."
  );

  await closeSession(session.session_id);
}

module.exports = { intro, handle };