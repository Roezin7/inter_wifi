// src/handlers/flows/faq.js
const { matchFaq, getFaqById, listFaqsByCategory, norm } = require("../../services/faqService");

function intro() {
  return (
    "¡Claro! 😊 ¿Qué información necesitas?\n\n" +
    "1) Horarios\n" +
    "2) Ubicación\n" +
    "3) Formas de pago\n" +
    "4) Precios / paquetes\n\n" +
    "Responde con *1, 2, 3, 4* o escríbelo (ej: “horarios”)."
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

function formatAnswerPro(rawAnswer, category) {
  // arregla \n literal
  let a = String(rawAnswer || "").replace(/\\n/g, "\n").trim();
  a = a.replace(/\n{3,}/g, "\n\n");

  const cat = norm(category);

  const header =
    cat === "info"
      ? "📌 *Información*\n\n"
      : cat === "pagos"
        ? "💳 *Pagos*\n\n"
        : cat === "precios"
          ? "💰 *Precios y paquetes*\n\n"
          : "";

  // cierre “empresa” corto
  const footer =
    "\n\n" +
    "¿Te apoyo con algo más? Si quieres, escribe *menú* para ver todas las opciones.";

  const alreadyHasFooter = /(escribe \*menu\*|escribe menu|te apoyo con algo mas)/i.test(a);
  return header + a + (alreadyHasFooter ? "" : footer);
}

/**
 * Respuesta “Paquete Pagos” (PRO):
 * junta las FAQs de categoría pagos y arma un mensaje único.
 */
async function buildPaymentsBundle() {
  const faqs = await listFaqsByCategory("pagos");

  if (!faqs.length) {
    return (
      "💳 *Pagos*\n\n" +
      "Por ahora no tengo la información de pagos cargada.\n" +
      "Escribe *agente* y un asesor te apoya."
    );
  }

  // Priorizamos: transfer/deposito (id 5), fechas (id 2), oficina (id 3), despues de pagar (id 6), donde enviar (id 7)
  const order = [5, 2, 3, 6, 7];
  const byId = new Map(faqs.map((f) => [Number(f.id), f]));
  const picked = [];

  for (const id of order) if (byId.has(id)) picked.push(byId.get(id));
  // agrega cualquier otro (por si creces el set)
  for (const f of faqs) if (!picked.some((x) => x.id === f.id)) picked.push(f);

  const lines = [];
  lines.push("💳 *Pagos*\n");
  for (const f of picked) {
    const title = String(f.question || "").replace(/\?+$/, "").trim();
    const ans = String(f.answer || "").replace(/\\n/g, "\n").trim();
    lines.push(`*${title}*\n${ans}\n`);
  }

  lines.push("Si ya pagaste, también puedes escribir *registrar pago* para subir tu comprobante ✅");
  lines.push("¿Necesitas algo más? Escribe *menú* para ver opciones.");

  return lines.join("\n");
}

async function handle({ session, inbound, send, updateSession, closeSession }) {
  const step = Number(session.step || 1);
  const data = session.data || {};
  const text = String(inbound.text || "").trim();

  // Si llega vacío, reenvía intro una sola vez
  if (!text) {
    if (step === 1) {
      await send(intro());
      return;
    }
    await send("¿Me dices si es *horarios*, *ubicación*, *pagos* o *precios*? 🙂");
    return;
  }

  // ===== STEP 1 =====
  if (step === 1) {
    const choice = parseFaqChoice(text);

    // ✅ si elige 1–4: determinístico y sin match
    if (choice === "horarios") {
      const f = await getFaqById(4);
      if (f?.answer) {
        await send(formatAnswerPro(f.answer, f.category));
        await closeSession(session.session_id);
        return;
      }
    }

    if (choice === "ubicacion") {
      const f = await getFaqById(1);
      if (f?.answer) {
        await send(formatAnswerPro(f.answer, f.category));
        await closeSession(session.session_id);
        return;
      }
    }

    if (choice === "pagos") {
      await send(await buildPaymentsBundle());
      await closeSession(session.session_id);
      return;
    }

    if (choice === "precios") {
      // (no tienes precios hoy en DB)
      await send(
        "💰 *Precios y paquetes*\n\n" +
        "Aún no tengo la lista de paquetes cargada en este chat.\n" +
        "Escribe *agente* y un asesor te manda la info al momento.\n\n" +
        "También puedes escribir *menú* para ver opciones."
      );
      await closeSession(session.session_id);
      return;
    }

    // ✅ texto libre: intenta match con score mejorado
    const threshold = Number(process.env.FAQ_MATCH_THRESHOLD || 0.62);
    const m = await matchFaq(text, threshold);

    if (m?.matched && m?.faq?.answer) {
      await send(formatAnswerPro(m.faq.answer, m.faq.category));
      await closeSession(session.session_id);
      return;
    }

    // No match: pide clarificación (una vez) y pasa a step 2
    await updateSession({ step: 2, data: { ...data, last_query: text } });

    await send(
      "Para ayudarte mejor, dime cuál necesitas:\n\n" +
      "1) Horarios\n" +
      "2) Ubicación\n" +
      "3) Formas de pago\n" +
      "4) Precios / paquetes\n\n" +
      "Responde con *1–4* o escríbelo 🙂"
    );
    return;
  }

  // ===== STEP 2 =====
  if (step === 2) {
    const choice = parseFaqChoice(text);

    // si responde 1-4 ya resolvemos determinístico
    if (choice) {
      // reusamos el step 1 “determinístico”
      await updateSession({ step: 1, data });
      // llamada recursiva segura (sin loops): procesamos como si fuera step 1
      session.step = 1;
      inbound.text = text;
      return handle({ session, inbound, send, updateSession, closeSession });
    }

    const queryText = text || data.last_query || "";

    const threshold = Number(process.env.FAQ_MATCH_THRESHOLD || 0.62);
    const m = await matchFaq(queryText, threshold);

    if (m?.matched && m?.faq?.answer) {
      await send(formatAnswerPro(m.faq.answer, m.faq.category));
      await closeSession(session.session_id);
      return;
    }

    // sigue sin match => salida limpia (sin spamear)
    await send(
      "Puedo ayudarte con:\n" +
      "• *Horarios*\n" +
      "• *Ubicación*\n" +
      "• *Formas de pago*\n" +
      "• *Precios / paquetes*\n\n" +
      "Escríbeme una de esas opciones o responde con *1–4*. Si prefieres, escribe *agente*."
    );

    await closeSession(session.session_id);
    return;
  }

  await closeSession(session.session_id);
  await send("Listo ✅");
}

module.exports = { intro, handle };