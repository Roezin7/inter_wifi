// src/handlers/flows/faq.js
const {
  matchFaq,
  getFaqById,
  getFaqSummaryByGroup,
  norm,
  canonicalIntent,
} = require("../../services/faqService");

function intro() {
  return (
    "¡Claro! 😊 ¿Qué información necesitas?\n\n" +
    "1) Horarios\n" +
    "2) Ubicación\n" +
    "3) Formas de pago\n" +
    "4) Precios / paquetes\n\n" +
    "Responde con *1, 2, 3, 4* o escríbelo (ej: “horarios”).\n\n" +
    "Para volver al menú principal escribe *menú* o *inicio*."
  );
}

function parseFaqChoice(text) {
  const t = norm(text);
  if (t === "1") return "horarios";
  if (t === "2") return "ubicacion";
  if (t === "3") return "pagos";
  if (t === "4") return "precios";
  return null;
}

function fixNewlines(s) {
  return String(s || "")
    .replace(/\\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function wrapPro(rawAnswer, category) {
  const a = fixNewlines(rawAnswer);
  const cat = norm(category);

  const header =
    cat === "info"
      ? "📌 *Información*\n\n"
      : cat === "pagos"
      ? "💳 *Pagos*\n\n"
      : cat === "precios"
      ? "💰 *Precios y paquetes*\n\n"
      : "";

  return header + a;
}

async function getSummary(groupKey) {
  const f = await getFaqSummaryByGroup(groupKey);
  return f?.answer ? wrapPro(f.answer, f.category) : null;
}

function paymentsDetailHint() {
  return (
    "\n\n¿Quieres más detalle? Puedes escribir:\n" +
    "• *fechas de pago*\n" +
    "• *transferencia / depósito*\n" +
    "• *pago en oficina*\n" +
    "• *enviar comprobante*\n\n" +
    "Para volver al menú principal escribe *menú* o *inicio*."
  );
}

function pricesDetailHint() {
  return (
    "\n\nSi quieres seguir:\n" +
    "• Escribe *cobertura* (y te pido colonia + calle)\n" +
    "• O escribe *contratar internet* para iniciar solicitud\n\n" +
    "Para volver al menú principal escribe *menú* o *inicio*."
  );
}

async function replyAndKeepMenu(send, message) {
  // Responde + vuelve a mostrar el menú FAQ para mantener al usuario “en info”
  await send(`${message}\n\n— — —\n\n${intro()}`);
}

async function handle({ session, inbound, send /* NO closeSession */ }) {
  const text = String(inbound.text || "").trim();

  // Si llega vacío, solo muestra menú FAQ (sin cerrar)
  if (!text) {
    await send(intro());
    return;
  }

  const choice = parseFaqChoice(text);

  if (choice === "horarios") {
    const f = await getFaqById(4);
    if (f?.answer) await replyAndKeepMenu(send, wrapPro(f.answer, f.category));
    else await replyAndKeepMenu(send, "📌 *Información*\n\nPor ahora no tengo el horario cargado. Escribe *agente*.");
    return;
  }

  if (choice === "ubicacion") {
    const f = await getFaqById(1);
    if (f?.answer) await replyAndKeepMenu(send, wrapPro(f.answer, f.category));
    else await replyAndKeepMenu(send, "📌 *Información*\n\nPor ahora no tengo la ubicación cargada. Escribe *agente*.");
    return;
  }

  if (choice === "pagos") {
    const summary = await getSummary("pagos");
    if (!summary) {
      await replyAndKeepMenu(send, "💳 *Pagos*\n\nPor ahora no tengo la información de pagos cargada. Escribe *agente*.");
      return;
    }
    await replyAndKeepMenu(send, summary + paymentsDetailHint());
    return;
  }

  if (choice === "precios") {
    const summary = await getSummary("precios");
    if (!summary) {
      await replyAndKeepMenu(send, "💰 *Precios y paquetes*\n\nPor ahora no tengo paquetes cargados. Escribe *agente*.");
      return;
    }
    await replyAndKeepMenu(send, summary + pricesDetailHint());
    return;
  }

  // Texto libre
  const canon = canonicalIntent(text);

  if (canon === "pagos") {
    const summary = await getSummary("pagos");
    if (summary) {
      await replyAndKeepMenu(send, summary + paymentsDetailHint());
      return;
    }
  }

  if (canon === "precios") {
    const summary = await getSummary("precios");
    if (summary) {
      await replyAndKeepMenu(send, summary + pricesDetailHint());
      return;
    }
  }

  const threshold = Number(process.env.FAQ_MATCH_THRESHOLD || 0.62);
  const m = await matchFaq(text, threshold);

  if (m?.matched && m?.faq?.answer) {
    await replyAndKeepMenu(send, wrapPro(m.faq.answer, m.faq.category));
    return;
  }

  // no match => vuelve a mostrar menú FAQ (sin cerrar)
  await send(
    "Para ayudarte mejor, elige una opción:\n\n" +
      "1) Horarios\n" +
      "2) Ubicación\n" +
      "3) Formas de pago\n" +
      "4) Precios / paquetes\n\n" +
      "O escribe tu duda (ej: “transferencia”, “ubicación”).\n\n" +
      "Para volver al menú principal escribe *menú* o *inicio*."
  );
}

module.exports = { intro, handle };