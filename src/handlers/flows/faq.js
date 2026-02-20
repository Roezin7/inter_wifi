// src/handlers/flows/faq.js
const { matchFaq } = require("../../services/faqService");

function intro() {
  return "¡Claro! 🙂 ¿Qué duda tienes? (horarios, ubicación, pagos, precios, etc.)";
}

async function handle({ session, inbound, send, closeSession }) {
  const threshold = Number(process.env.FAQ_MATCH_THRESHOLD || 0.7);
  const text = String(inbound.text || "").trim();

  const m = await matchFaq(text, threshold);

  if (m?.matched && m?.faq?.answer) {
    await send(m.faq.answer);
    await closeSession(session.session_id);
    return;
  }

  // ✅ NO lista rígida; 1 pregunta natural
  await send(
    "Te ayudo con gusto 🙂\n" +
    "¿Tu duda es sobre *horarios*, *ubicación* o *formas de pago*?"
  );

  // cerramos para no “atorar” el chat en FAQ si el usuario cambia de tema
  await closeSession(session.session_id);
}

module.exports = { intro, handle };