// src/handlers/flows/contrato.js
const {
  hasMinLen,
  looksLikePhone10MX,
  normalizeMX10ToE164,
  hasMediaUrls
} = require("../../utils/validators");

const { findColoniaMatch } = require("../../services/coverageService");
const { createContract } = require("../../services/contractsService");
const { notifyAdmin } = require("../../services/notifyService");
const { extractColoniaHint, parsePhoneE164 } = require("../../services/llmService");

// Variación opcional
let templates, pick;
try {
  ({ templates, pick } = require("../../utils/replies"));
} catch {}

/** Heurística: evita IA si NO parece dirección */
function looksLikeAddress(text) {
  const s = String(text || "").trim();
  if (s.length < 3) return false;

  const hasNumber = /\d/.test(s);
  const hasComma = s.includes(",");
  const hasColWord = /(col\.?|colonia|fracc\.?|fraccionamiento|barrio|centro)/i.test(s);
  const words = s.split(/\s+/).filter(Boolean);

  // "Hidalgo" (1 palabra sin número) => NO
  if (words.length === 1 && !hasNumber) return false;

  // Si trae coma o número o palabra colonia => sí parece dirección
  if (hasComma || hasNumber || hasColWord) return true;

  // Si trae 2+ palabras, pero muy corto, igual no
  if (words.length >= 2 && s.length >= 10) return true;

  return false;
}

function intro(seed) {
  if (templates && pick) return pick(templates.contrato_intro, seed)();
  return (
    "Va, te ayudo con la contratación 🙌\n" +
    "Para revisar cobertura, ¿me compartes *colonia* y *calle con número*?\n" +
    "Ejemplo: “Morelos, Hidalgo 123”."
  );
}

function askColoniaMoreDetail(seed) {
  if (templates && pick) return pick(templates.ask_colonia_more_detail, seed)();
  return "Gracias. ¿En qué *colonia* queda esa calle? Con *colonia + calle + número* te confirmo rápido 🙂";
}

function confirmColonia(col, seed) {
  if (templates && pick) return pick(templates.confirm_colonia, seed)(col);
  return `Perfecto, entonces es *${col}*. ¿Correcto?`;
}

async function handle({ session, inbound, send, updateSession, closeSession }) {
  const step = Number(session.step || 1);
  const data = session.data || {};
  const phoneE164 = session.phone_e164 || inbound.phoneE164;

  // STEP 1: captura dirección/colonia
  if (step === 1) {
    const txt = String(inbound.text || "").trim();

    // Mensajes vacíos/saludos
    if (!hasMinLen(txt, 3)) {
      await send(intro(phoneE164));
      return;
    }

    // Si no parece dirección, pide colonia (sin IA)
    if (!looksLikeAddress(txt)) {
      await send(askColoniaMoreDetail(phoneE164));
      return;
    }

    // Extraer colonia con LLM (SIN romper si falla)
    let queryText = txt;
    if (txt.length >= 8) {
      try {
        const hint = await extractColoniaHint(txt);
        const guess = String(hint?.colonia_norm_guess || "").trim();
        if (guess) queryText = guess;
      } catch {
        // no pasa nada
      }
    }

    const match = await findColoniaMatch(queryText);

    if (!match?.found || !match?.match?.colonia) {
      await send(
        "Te sigo 🙂 ¿me lo mandas así: *Colonia, Calle y Número*?\n" +
        "Ejemplo: “Morelos, Hidalgo 123”."
      );
      return;
    }

    const nextData = {
      ...data,
      colonia_input: txt,
      colonia: match.match.colonia,
      colonia_norm: match.match.colonia_norm || null,
      cobertura: match.match.cobertura,
      zona: match.match.zona || null,
      colonia_confirmed: false
    };

    // Confirmación humana
    await updateSession({ step: 10, data: nextData });
    await send(confirmColonia(nextData.colonia, phoneE164));
    return;
  }

  // STEP 10: confirmar colonia (sí/no)
  if (step === 10) {
    const t = String(inbound.text || "").trim().toLowerCase();

    const isYes = /(si|sí|correcto|asi es|así es|exacto|ok|va|confirmo)/i.test(t);
    const isNo  = /(no|nel|incorrecto|equivocado|error)/i.test(t);

    if (isYes) {
      const confirmedData = { ...data, colonia_confirmed: true };

      // sin cobertura
      if (String(confirmedData.cobertura || "").toUpperCase() === "NO") {
        await updateSession({ step: 99, data: confirmedData });
        await send(
          `Gracias. Por ahora *no tenemos cobertura* en *${confirmedData.colonia}*.\n` +
          "Si gustas, dime tu *nombre* y un *teléfono* y te avisamos cuando llegue 🙏"
        );
        return;
      }

      await updateSession({ step: 2, data: confirmedData });
      await send("Excelente 🙌 ¿Cuál es tu *nombre completo*?");
      return;
    }

    if (isNo) {
      await updateSession({ step: 1, data: { ...data, colonia_confirmed: false } });
      await send("Va, corrígeme 🙂 ¿Cuál es tu *colonia* y tu *calle con número*? (Ej: Morelos, Hidalgo 123)");
      return;
    }

    // Si mandan otra dirección (no dicen sí/no), regresamos a step 1 pero sin loop agresivo
    await updateSession({ step: 1, data: { ...data, colonia_confirmed: false } });
    await send("Perfecto. Pásame por favor *colonia, calle y número* (Ej: Morelos, Hidalgo 123).");
    return;
  }

  // STEP 2: nombre
  if (step === 2) {
    const txt = String(inbound.text || "").trim();
    if (!hasMinLen(txt, 3)) {
      await send("¿Me compartes tu *nombre completo*, por favor?");
      return;
    }
    await updateSession({ step: 3, data: { ...data, nombre: txt } });
    await send("Perfecto. ¿Qué *teléfono* dejamos de contacto? (10 dígitos o escribe *mismo*)");
    return;
  }

  // STEP 3: teléfono
  if (step === 3) {
    const raw = String(inbound.text || "").trim();
    const lower = raw.toLowerCase();

    let tel = null;

    if (lower.includes("mismo")) tel = phoneE164;

    if (!tel && looksLikePhone10MX(raw)) {
      tel = normalizeMX10ToE164(raw);
    }

    if (!tel) {
      try {
        const parsed = await parsePhoneE164(raw, phoneE164);
        tel = parsed?.phone_e164 || null;
      } catch {
        tel = null;
      }
    }

    if (!tel) {
      await send("Ponme un teléfono de *10 dígitos* (ej. 4491234567) o escribe *mismo* 🙂");
      return;
    }

    await updateSession({ step: 4, data: { ...data, telefono_contacto: tel } });
    await send("Listo ✅ Ahora envíame foto de tu *INE (frente)* 📸");
    return;
  }

  // STEP 4: INE frente
  if (step === 4) {
    if (!hasMediaUrls(inbound.media)) {
      await send("Necesito la *foto del frente* de la INE 📸 (envíala como imagen, porfa)");
      return;
    }
    const url = inbound.media.urls[0];
    await updateSession({ step: 5, data: { ...data, ine_frente_url: url } });
    await send("Gracias. Ahora envíame la foto de tu *INE (atrás)* 📸");
    return;
  }

  // STEP 5: INE atrás + crear contrato
  if (step === 5) {
    if (!hasMediaUrls(inbound.media)) {
      await send("Necesito la *foto de atrás* de la INE 📸 (envíala como imagen, porfa)");
      return;
    }

    const url = inbound.media.urls[0];
    const finalData = { ...data, ine_reverso_url: url };

    const c = await createContract({
      phoneE164,
      nombre: finalData.nombre,
      colonia: finalData.colonia,
      cobertura: finalData.cobertura,
      zona: finalData.zona,
      telefono_contacto: finalData.telefono_contacto,
      ine_frente_url: finalData.ine_frente_url,
      ine_reverso_url: finalData.ine_reverso_url
    });

    await notifyAdmin(
      `📩 NUEVO CONTRATO ${c.folio}\n` +
      `Nombre: ${c.nombre}\n` +
      `Tel: ${c.telefono_contacto}\n` +
      `Colonia: ${c.colonia} (Zona: ${c.zona || "N/A"})\n` +
      `INE frente: ${c.ine_frente_url}\n` +
      `INE atrás: ${c.ine_reverso_url}`
    );

    await closeSession(session.session_id);
    await send(
      `Listo ✅ Ya quedó tu solicitud.\n` +
      `Folio: *${c.folio}*\n\n` +
      "En breve te contactamos para confirmar la instalación 🙌"
    );
    return;
  }

  // STEP 99: sin cobertura
  if (step === 99) {
    const txt = String(inbound.text || "").trim();
    if (!hasMinLen(txt, 3)) {
      await send("Dime tu *nombre* y un *teléfono* para avisarte cuando haya cobertura 🙂");
      return;
    }
    await closeSession(session.session_id);
    await send("¡Gracias! ✅ Quedó registrado. En cuanto haya cobertura te avisamos 🙏");
    return;
  }

  await closeSession(session.session_id);
  await send("Listo ✅ Si necesitas algo más, aquí estoy.");
}

module.exports = { intro, handle };