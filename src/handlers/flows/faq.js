// src/handlers/flows/faq.js
const {
  matchFaq,
  getFaqById,
  getFaqSummaryByGroup,
  norm,
  canonicalIntent,
} = require("../../services/faqService");

// ===== UI =====
function faqMenu() {
  return (
    "¡Claro! 😊 ¿Qué información necesitas?\n\n" +
    "1) Horarios\n" +
    "2) Ubicación\n" +
    "3) Formas de pago\n" +
    "4) Precios / paquetes\n\n" +
    "Responde con *1, 2, 3, 4* o escríbelo (ej: “horarios”).\n" +
    "Para volver al menú principal escribe *inicio*."
  );
}

function footerShort() {
  return "\n\n¿Algo más? Escribe *1-4* o *inicio*.";
}

function intro() {
  // compat con inbound.getIntro()
  return faqMenu();
}

function parseFaqChoice(text) {
  const t = norm(text);
  if (t === "1") return "horarios";
  if (t === "2") return "ubicacion";
  if (t === "3") return "pagos";
  if (t === "4") return "precios";
  return null;
}

function isFaqMenuWord(text) {
  // “menu” NO aquí (menu = principal). Esto es SOLO para mostrar opciones FAQ.
  return /^(info|informacion|información|opciones|ayuda|help)$/i.test(norm(text));
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
    "\n\nPuedes escribir: *fechas de pago*, *transferencia*, *depósito*, *enviar comprobante*."
  );
}

function pricesDetailHint() {
  return "\n\nPuedes escribir: *cobertura* o *contratar internet*.";
}

/**
 * ✅ Regla: FAQ NO CIERRA sesión
 * ✅ Regla: NO re-mandar menú completo; solo al entrar o si piden "opciones/info/ayuda"
 * ✅ Mantenerse en FAQ hasta que el usuario escriba "inicio" (lo maneja inbound)
 */
async function handle({ session, inbound, send, updateSession }) {
  const step = Number(session.step || 1);
  const data = session.data || {};
  const text = String(inbound.text || "").trim();

  // Si el usuario manda vacío o pide opciones explícitas -> mostrar menú FAQ
  if (!text || isFaqMenuWord(text)) {
    // asegúrate de marcar que ya está "dentro" del FAQ
    if (step !== 1 || !data.faq_entered) {
      await updateSession({ step: 1, data: { ...data, faq_entered: true } });
    }
    await send(faqMenu());
    return;
  }

  const choice = parseFaqChoice(text);

  // ===== DETERMINÍSTICO POR MENÚ FAQ =====
  if (choice === "horarios") {
    const f = await getFaqById(4);
    const msg = f?.answer
      ? wrapPro(f.answer, f.category)
      : "📌 *Información*\n\nPor ahora no tengo el horario cargado. Escribe *agente*.";
    await updateSession({ step: 2, data: { ...data, faq_entered: true, last: "horarios" } });
    await send(msg + footerShort());
    return;
  }

  if (choice === "ubicacion") {
    const f = await getFaqById(1);
    const msg = f?.answer
      ? wrapPro(f.answer, f.category)
      : "📌 *Información*\n\nPor ahora no tengo la ubicación cargada. Escribe *agente*.";
    await updateSession({ step: 2, data: { ...data, faq_entered: true, last: "ubicacion" } });
    await send(msg + footerShort());
    return;
  }

  if (choice === "pagos") {
    const summary = await getSummary("pagos");
    const msg = summary
      ? summary + paymentsDetailHint()
      : "💳 *Pagos*\n\nPor ahora no tengo la información de pagos cargada. Escribe *agente*.";
    await updateSession({ step: 2, data: { ...data, faq_entered: true, last: "pagos" } });
    await send(msg + footerShort());
    return;
  }

  if (choice === "precios") {
    const summary = await getSummary("precios");
    const msg = summary
      ? summary + pricesDetailHint()
      : "💰 *Precios y paquetes*\n\nPor ahora no tengo paquetes cargados. Escribe *agente*.";
    await updateSession({ step: 2, data: { ...data, faq_entered: true, last: "precios" } });
    await send(msg + footerShort());
    return;
  }

  // ===== TEXTO LIBRE (match) =====
  const canon = canonicalIntent(text);

  // Canon pag/precios -> resumen
  if (canon === "pagos") {
    const summary = await getSummary("pagos");
    if (summary) {
      await updateSession({ step: 2, data: { ...data, faq_entered: true, last: "pagos" } });
      await send(summary + paymentsDetailHint() + footerShort());
      return;
    }
  }

  if (canon === "precios") {
    const summary = await getSummary("precios");
    if (summary) {
      await updateSession({ step: 2, data: { ...data, faq_entered: true, last: "precios" } });
      await send(summary + pricesDetailHint() + footerShort());
      return;
    }
  }

  // match normal
  const threshold = Number(process.env.FAQ_MATCH_THRESHOLD || 0.62);
  const m = await matchFaq(text, threshold);

  if (m?.matched && m?.faq?.answer) {
    await updateSession({ step: 2, data: { ...data, faq_entered: true, last: m.faq?.id || null } });
    await send(wrapPro(m.faq.answer, m.faq.category) + footerShort());
    return;
  }

  // no match: NO mandes menú completo; solo micro guía
  await updateSession({ step: 2, data: { ...data, faq_entered: true, last: "no_match" } });
  await send("No te entendí del todo 😅 Escribe *1-4* para opciones o *inicio* para volver al menú principal.");
}

module.exports = { intro, handle };