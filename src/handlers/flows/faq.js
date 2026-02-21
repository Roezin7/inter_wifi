// src/handlers/flows/faq.js
const {
  matchFaq,
  getFaqById,
  getFaqSummaryByGroup,
  listFaqsByCategory,
  norm,
  canonicalIntent
} = require("../../services/faqService");

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

function fixNewlines(s) {
  return String(s || "").replace(/\\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function wrapPro(rawAnswer, category) {
  const a = fixNewlines(rawAnswer);
  const cat = norm(category);

  const header =
    cat === "info" ? "📌 *Información*\n\n" :
    cat === "pagos" ? "💳 *Pagos*\n\n" :
    cat === "precios" ? "💰 *Precios y paquetes*\n\n" :
    "";

  return header + a;
}

/**
 * Muestra resumen “tipo flyer” para pagos/paquetes.
 */
async function sendSummary(send, groupKey) {
  const f = await getFaqSummaryByGroup(groupKey);
  if (!f?.answer) return false;
  await send(wrapPro(f.answer, f.category));
  return true;
}

function askMoreDetailsFor(groupKey) {
  if (groupKey === "pagos") {
    return (
      "\n\n¿Necesitas más detalle?\n" +
      "1) Fechas de pago\n" +
      "2) Transferencia / depósito\n" +
      "3) Pago en oficina\n" +
      "4) Enviar comprobante\n\n" +
      "Responde con *1–4* o escribe tu duda."
    );
  }

  if (groupKey === "precios") {
    return (
      "\n\n¿Quieres que te ayude con algo más?\n" +
      "1) Requisitos\n" +
      "2) Confirmar cobertura\n" +
      "3) Contratar\n\n" +
      "Responde con *1–3* o escribe tu duda."
    );
  }

  return "\n\n¿Te apoyo con algo más? 🙂";
}

/**
 * Map interno de sub-menús (para que “1” no se confunda).
 * Guardamos data.faq_mode cuando mostramos resumen.
 */
function parseFollowupChoice(text, mode) {
  const t = norm(text);

  if (mode === "pagos") {
    if (t === "1") return "fechas";
    if (t === "2") return "transferencia";
    if (t === "3") return "oficina";
    if (t === "4") return "comprobante";
  }

  if (mode === "precios") {
    if (t === "1") return "requisitos";
    if (t === "2") return "cobertura";
    if (t === "3") return "contratar";
  }

  return null;
}

async function handle({ session, inbound, send, updateSession, closeSession }) {
  const step = Number(session.step || 1);
  const data = session.data || {};
  const text = String(inbound.text || "").trim();

  // STEP 1: entrada FAQ
  if (step === 1) {
    if (!text) {
      await send(intro());
      return;
    }

    const choice = parseFaqChoice(text);

    // Determinístico por menú FAQ
    if (choice === "horarios") {
      const f = await getFaqById(4);
      if (f?.answer) {
        await send(wrapPro(f.answer, f.category));
        await closeSession(session.session_id);
        return;
      }
    }

    if (choice === "ubicacion") {
      const f = await getFaqById(1);
      if (f?.answer) {
        await send(wrapPro(f.answer, f.category));
        await closeSession(session.session_id);
        return;
      }
    }

    // ✅ Pagos => SOLO resumen + “más detalle”
    if (choice === "pagos") {
      const ok = await sendSummary(send, "pagos");
      if (!ok) {
        await send("💳 *Pagos*\n\nPor ahora no tengo la información de pagos cargada. Escribe *agente*.");
        await closeSession(session.session_id);
        return;
      }

      await updateSession({
        step: 2,
        data: { ...data, faq_mode: "pagos" }
      });

      await send(askMoreDetailsFor("pagos"));
      return; // NO cerramos: esperamos si quiere detalle
    }

    // ✅ Precios/paquetes => resumen + follow-up
    if (choice === "precios") {
      const ok = await sendSummary(send, "precios");
      if (!ok) {
        await send("💰 *Precios y paquetes*\n\nAún no tengo paquetes cargados. Escribe *agente*.");
        await closeSession(session.session_id);
        return;
      }

      await updateSession({
        step: 2,
        data: { ...data, faq_mode: "precios" }
      });

      await send(askMoreDetailsFor("precios"));
      return;
    }

    // Texto libre: match normal
    const threshold = Number(process.env.FAQ_MATCH_THRESHOLD || 0.62);
    const m = await matchFaq(text, threshold);

    // Si el usuario dijo "pagos" / "paquetes" (canónico) -> manda resumen, no detalle
    const canon = canonicalIntent(text);
    if (canon === "pagos") {
      const ok = await sendSummary(send, "pagos");
      if (ok) {
        await updateSession({ step: 2, data: { ...data, faq_mode: "pagos" } });
        await send(askMoreDetailsFor("pagos"));
        return;
      }
    }
    if (canon === "precios") {
      const ok = await sendSummary(send, "precios");
      if (ok) {
        await updateSession({ step: 2, data: { ...data, faq_mode: "precios" } });
        await send(askMoreDetailsFor("precios"));
        return;
      }
    }

    if (m?.matched && m?.faq?.answer) {
      // Si por alguna razón matchea SUMMARY directo, lo tratamos como resumen + follow-up
      if (String(m.faq.kind || "").toUpperCase() === "SUMMARY" && m.faq.group_key) {
        await send(wrapPro(m.faq.answer, m.faq.category));
        await updateSession({ step: 2, data: { ...data, faq_mode: m.faq.group_key } });
        await send(askMoreDetailsFor(m.faq.group_key));
        return;
      }

      await send(wrapPro(m.faq.answer, m.faq.category));
      await closeSession(session.session_id);
      return;
    }

    // No match: pide clarificación una vez
    await updateSession({ step: 2, data: { ...data, faq_mode: null, last_query: text } });
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

  // STEP 2: follow-up / clarificación
  if (step === 2) {
    const mode = data.faq_mode || null;

    // si estamos en modo pagos/precios, “1-4” significa submenú, NO inbound
    if (mode) {
      const sub = parseFollowupChoice(text, mode);

      // PAGOS detalle
      if (mode === "pagos") {
        if (sub === "fechas") {
          const f = await getFaqById(2);
          if (f?.answer) await send(wrapPro(f.answer, f.category));
          await closeSession(session.session_id);
          return;
        }
        if (sub === "transferencia") {
          const f = await getFaqById(5);
          if (f?.answer) await send(wrapPro(f.answer, f.category));
          await closeSession(session.session_id);
          return;
        }
        if (sub === "oficina") {
          const f = await getFaqById(3);
          if (f?.answer) await send(wrapPro(f.answer, f.category));
          await closeSession(session.session_id);
          return;
        }
        if (sub === "comprobante") {
          // aquí podrías mandar 6 o 7, según lo que te convenga
          const f = await getFaqById(6);
          if (f?.answer) await send(wrapPro(f.answer, f.category));
          await closeSession(session.session_id);
          return;
        }

        // si escribe una pregunta real, match normal contra DETAIL pagos
        const threshold = Number(process.env.FAQ_MATCH_THRESHOLD || 0.62);
        const m = await matchFaq(text, threshold);

        if (m?.matched && m?.faq?.answer) {
          await send(wrapPro(m.faq.answer, m.faq.category));
          await closeSession(session.session_id);
          return;
        }

        await send(
          "¿Qué detalle necesitas?\n" +
          "1) Fechas de pago\n" +
          "2) Transferencia / depósito\n" +
          "3) Pago en oficina\n" +
          "4) Enviar comprobante\n\n" +
          "O escribe tu duda 🙂"
        );
        return;
      }

      // PRECIOS follow-up (requisitos / cobertura / contratar)
      if (mode === "precios") {
        if (sub === "requisitos") {
          await send(
            "🧾 *Requisitos*\n\n" +
            "• INE\n" +
            "• Comprobante de domicilio\n\n" +
            "Si quieres, dime tu *colonia* y tu *calle con número* para revisar cobertura ✅"
          );
          await closeSession(session.session_id);
          return;
        }
        if (sub === "cobertura") {
          await send("Perfecto ✅ Dime tu *colonia* y tu *calle con número* para revisar cobertura (ej: “Centro, Hidalgo 123”).");
          await closeSession(session.session_id);
          return;
        }
        if (sub === "contratar") {
          await send("Excelente 🙌 Escribe *contratar internet* para iniciar tu solicitud, o dime tu *colonia* y *calle con número* para revisar cobertura primero ✅");
          await closeSession(session.session_id);
          return;
        }

        // texto libre
        const threshold = Number(process.env.FAQ_MATCH_THRESHOLD || 0.62);
        const m = await matchFaq(text, threshold);

        if (m?.matched && m?.faq?.answer) {
          await send(wrapPro(m.faq.answer, m.faq.category));
          await closeSession(session.session_id);
          return;
        }

        await send("¿Quieres *requisitos*, *cobertura* o *contratar*? Responde 1–3 🙂");
        return;
      }
    }

    // clarificación genérica (sin modo)
    const choice = parseFaqChoice(text);
    if (choice) {
      // re-procesar como step 1 sin recursión rara:
      await updateSession({ step: 1, data: { ...data, faq_mode: null } });
      session.step = 1;
      return handle({ session, inbound, send, updateSession, closeSession });
    }

    const queryText = text || data.last_query || "";
    const threshold = Number(process.env.FAQ_MATCH_THRESHOLD || 0.62);
    const m = await matchFaq(queryText, threshold);

    if (m?.matched && m?.faq?.answer) {
      await send(wrapPro(m.faq.answer, m.faq.category));
      await closeSession(session.session_id);
      return;
    }

    await send(
      "Puedo ayudarte con:\n" +
      "• *Horarios*\n" +
      "• *Ubicación*\n" +
      "• *Formas de pago*\n" +
      "• *Precios / paquetes*\n\n" +
      "Responde con *1–4* o escribe tu duda. Si prefieres, escribe *agente*."
    );

    await closeSession(session.session_id);
    return;
  }

  await closeSession(session.session_id);
}

module.exports = { intro, handle };