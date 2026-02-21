// src/handlers/flows/faq.js
const { matchFaq } = require("../../services/faqService");

function intro() {
  return "¡Claro! 🙂 ¿Qué información necesitas? (horarios, ubicación, formas de pago, etc.)";
}

// mini-router local (sin números)
function fastFaqIntent(text) {
  const t = String(text || "").toLowerCase();

  if (/(horario|horarios|abren|cierran|oficina|atenci[oó]n)/i.test(t)) return "horarios";
  if (/(ubic|direc|d[oó]nde|mapa|como llego|c[oó]mo llego)/i.test(t)) return "ubicacion";
  if (/(forma(s)? de pago|pagar|pago|transfer|deposit|oxxo|spin|azteca|tarjeta|credito|d[eé]bito)/i.test(t)) return "pagos";

  return null;
}

async function handle({ session, inbound, send, closeSession }) {
  const text = String(inbound.text || "").trim();
  const fast = fastFaqIntent(text);

  // 1) Si detecto intención FAQ clara, fuerzo match por category
  // (esto hace que "horarios" siempre traiga la respuesta correcta)
  const category = fast === "pagos" ? "pagos" : "info";

  const m = await matchFaq(text, {
    category,          // fuerza la categoría más probable
    threshold: 0.22,   // trigram backup
    limit: 5
  });

  if (m?.matched && m?.faq?.answer) {
    await send(m.faq.answer);
    await closeSession(session.session_id);
    return;
  }

  // 2) fallback ultra claro (sin números para no chocar con menú principal)
  await send(
    "Te ayudo con gusto 🙂\n" +
    "Dime cuál necesitas:\n" +
    "• *horarios*\n" +
    "• *ubicación*\n" +
    "• *formas de pago*\n\n" +
    "Tip: también puedes escribir *menú* para ver todas las opciones."
  );

  await closeSession(session.session_id);
}

module.exports = { intro, handle };