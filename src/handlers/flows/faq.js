// src/handlers/flows/faq.js
const { matchFaq } = require("../../services/faqService");

// Helpers
function norm(s) {
  return String(s || "")
    .toLowerCase()
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // quita acentos
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ");
}

function isYes(text) {
  return /^(si|simon|sí|ok|va|dale|correcto|exacto)$/i.test(norm(text));
}

function isNo(text) {
  return /^(no|nel|nope|incorrecto|equivocado)$/i.test(norm(text));
}

function detectTopic(text) {
  const t = norm(text);

  // SOLO palabra o frase corta
  if (/\b(horario|horarios|abren|cierran|abierto|cerrado|a que hora|a que horas|hora)\b/.test(t)) {
    return "HORARIOS";
  }
  if (/\b(ubicacion|ubicacion|direccion|direccion|donde|como llego|maps|google|ubicarlos)\b/.test(t)) {
    return "UBICACION";
  }
  if (/\b(pago|pagos|deposito|depositar|transferencia|transfer|spei|tarjeta|efectivo|forma de pago|como pago)\b/.test(t)) {
    return "PAGOS";
  }
  if (/\b(precio|precios|costo|costos|paquete|paquetes|plan|planes|mensualidad|cuanto cuesta)\b/.test(t)) {
    return "PRECIOS";
  }

  return null;
}

// Estas respuestas “rápidas” son el plan B cuando el matcher no encuentra nada.
// Ajusta el copy a tu negocio real.
function quickAnswer(topic) {
  if (topic === "HORARIOS") {
    return (
      "Nuestros horarios:\n" +
      "• Lunes a Viernes: __\n" +
      "• Sábado: __\n" +
      "• Domingo: __\n\n" +
      "Si me dices tu colonia, te confirmo también el horario de atención/instalación por tu zona 🙂"
    );
  }
  if (topic === "UBICACION") {
    return (
      "¿Me dices tu *colonia* y *calle con número* para ubicarte y confirmar cobertura?\n" +
      "Ejemplo: “Centro, Hidalgo 311”."
    );
  }
  if (topic === "PAGOS") {
    return (
      "Formas de pago:\n" +
      "• Efectivo\n" +
      "• Transferencia (SPEI)\n" +
      "• Depósito\n\n" +
      "Si quieres registrar un pago, responde *3* en el menú o dime: “registrar pago”."
    );
  }
  if (topic === "PRECIOS") {
    return (
      "Te paso precios/planes en 1 mensaje 🙂\n" +
      "¿Me dices tu *colonia* para confirmarte qué paquetes aplican en tu zona?"
    );
  }
  return null;
}

function intro() {
  return (
    "¡Claro! 🙂\n" +
    "¿Qué información necesitas?\n" +
    "1) Horarios\n" +
    "2) Ubicación\n" +
    "3) Formas de pago\n" +
    "4) Precios / paquetes\n\n" +
    "Responde con 1, 2, 3, 4 o escríbelo (ej: “horarios”)."
  );
}

async function handle({ session, inbound, send, updateSession, closeSession }) {
  const step = Number(session.step || 1);
  const data = session.data || {};
  const textRaw = String(inbound.text || "").trim();
  const t = norm(textRaw);

  // Si viene vacío (stickers, etc.)
  if (!t) {
    await send(intro());
    return;
  }

  // =========================
  // STEP 1: resolver de una
  // =========================
  if (step === 1) {
    // 1) Si el usuario puso 1..4 dentro de FAQ
    if (t === "1") {
      await send(quickAnswer("HORARIOS"));
      await closeSession(session.session_id);
      return;
    }
    if (t === "2") {
      await send(quickAnswer("UBICACION"));
      // OJO: aquí normalmente NO cierras si quieres pedir dirección; pero por ahora lo cierro
      // para evitar atorado. Si quieres que siga, cambia a step=2.
      await closeSession(session.session_id);
      return;
    }
    if (t === "3") {
      await send(quickAnswer("PAGOS"));
      await closeSession(session.session_id);
      return;
    }
    if (t === "4") {
      await send(quickAnswer("PRECIOS"));
      await closeSession(session.session_id);
      return;
    }

    // 2) Si es palabra/frase corta tipo "horarios"
    const topic = detectTopic(t);
    if (topic) {
      const ans = quickAnswer(topic);
      if (ans) {
        await send(ans);
        await closeSession(session.session_id);
        return;
      }
    }

    // 3) Intentar matcher de DB (preguntas completas)
    const threshold =
      t.split(" ").length <= 2
        ? Number(process.env.FAQ_MATCH_THRESHOLD_SHORT || 0.45) // 👈 clave para "horarios"
        : Number(process.env.FAQ_MATCH_THRESHOLD || 0.7);

    const m = await matchFaq(textRaw, threshold);

    if (m?.matched && m?.faq?.answer) {
      await send(m.faq.answer);
      await closeSession(session.session_id);
      return;
    }

    // 4) No entendimos: NO repitas la misma pregunta.
    // Guardamos último texto y pedimos escoger 1..4
    await updateSession({
      step: 2,
      data: { ...data, last_unmatched: textRaw }
    });

    await send(
      "Para ayudarte rápido, elige una opción:\n" +
        "1) Horarios\n2) Ubicación\n3) Formas de pago\n4) Precios / paquetes"
    );
    return;
  }

  // =========================
  // STEP 2: usuario elige 1..4
  // =========================
  if (step === 2) {
    if (t === "1") {
      await send(quickAnswer("HORARIOS"));
      await closeSession(session.session_id);
      return;
    }
    if (t === "2") {
      await send(quickAnswer("UBICACION"));
      await closeSession(session.session_id);
      return;
    }
    if (t === "3") {
      await send(quickAnswer("PAGOS"));
      await closeSession(session.session_id);
      return;
    }
    if (t === "4") {
      await send(quickAnswer("PRECIOS"));
      await closeSession(session.session_id);
      return;
    }

    // Si escribió texto en vez de número
    const topic = detectTopic(t);
    if (topic) {
      await send(quickAnswer(topic));
      await closeSession(session.session_id);
      return;
    }

    await send("¿Me confirmas con 1, 2, 3 o 4? 🙂");
    return;
  }

  // fallback final
  await closeSession(session.session_id);
  await send("Listo ✅");
}

module.exports = { intro, handle };