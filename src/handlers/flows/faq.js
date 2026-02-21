// src/handlers/flows/faq.js
const { matchFaq, getFaqById } = require("../../services/faqService");

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

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ");
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
  // 1) arregla "\n" literal desde DB
  let a = String(rawAnswer || "").replace(/\\n/g, "\n").trim();

  // 2) mejora micro-formato
  // - si vienen bullets con "•" está bien; si vienen con "-" igual
  a = a.replace(/\n{3,}/g, "\n\n");

  // 3) header por categoría (opcional)
  const cat = String(category || "").toLowerCase();
  const header =
    cat === "info" ? "📌 *Información*\n\n" :
    cat === "pagos" ? "💳 *Pagos*\n\n" :
    cat === "precios" ? "💰 *Precios y paquetes*\n\n" :
    "";

  // 4) cierre corporativo corto (no empalagoso)
  const footer =
    "\n\n" +
    "Si quieres, dime tu *colonia* y te confirmo también la cobertura y tiempos por tu zona ✅";

  // Evita duplicar footer si el answer ya trae algo parecido
  const alreadyHasFooter = /dime tu colonia|confirmo cobertura|por tu zona/i.test(a);
  return header + a + (alreadyHasFooter ? "" : footer);
}

async function handle({ session, inbound, send, updateSession, closeSession }) {
  const step = Number(session.step || 1);
  const data = session.data || {};
  const text = String(inbound.text || "").trim();

  // STEP 1: acabamos de entrar a FAQ
  // - Si el usuario entra por "4" desde menú principal (flow FAQ), inbound ya mandó intro
  // - Aquí aceptamos el número 1-4 o texto libre.
  if (step === 1) {
    const choice = parseFaqChoice(text);

    // Si NO hay texto (ej: llega webhook raro), re-pregunta
    if (!text) {
      await send(intro());
      return;
    }

    // Si eligió 1-4, convertimos a query “canonical”
    const queryText = choice || text;

    const threshold = Number(process.env.FAQ_MATCH_THRESHOLD || 0.62);
    const m = await matchFaq(queryText, threshold);

    // ✅ Match directo a una FAQ
    if (m?.matched && m?.faq?.answer) {
      await send(formatAnswerPro(m.faq.answer, m.faq.category));
      await closeSession(session.session_id);
      return;
    }

    // ❓ No match: pasamos a step 2 (modo clarificación)
    await updateSession({
      step: 2,
      data: {
        ...data,
        last_query: queryText
      }
    });

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

  // STEP 2: clarificación (usuario responde 1-4 o escribe algo)
  if (step === 2) {
    const choice = parseFaqChoice(text);
    const queryText = choice || text || data.last_query || "";

    if (!queryText) {
      await send("¿Me dices si es *horarios*, *ubicación*, *pagos* o *precios*? 🙂");
      return;
    }

    const threshold = Number(process.env.FAQ_MATCH_THRESHOLD || 0.62);
    const m = await matchFaq(queryText, threshold);

    if (m?.matched && m?.faq?.answer) {
      await send(formatAnswerPro(m.faq.answer, m.faq.category));
      await closeSession(session.session_id);
      return;
    }

    // Si sigue sin match: respuesta PRO + salida limpia (no atora el chat)
    await send(
      "Puedo ayudarte con:\n" +
      "• *Horarios*\n" +
      "• *Ubicación*\n" +
      "• *Formas de pago*\n" +
      "• *Precios / paquetes*\n\n" +
      "Escríbeme cualquiera de esas opciones, o escribe *menú* para ver todo."
    );

    await closeSession(session.session_id);
    return;
  }

  // fallback
  await closeSession(session.session_id);
  await send("Listo ✅");
}

module.exports = { intro, handle };