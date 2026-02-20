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

// (Opcional) si ya creaste replies.js, úsalo para variar.
// Si no existe aún, comenta estas 2 líneas y usa strings fijos.
let templates, pick;
try {
  ({ templates, pick } = require("../../utils/replies"));
} catch {}

/** Heurística: NO intentes “adivinar colonia” con IA si no parece dirección */
function looksLikeAddress(t) {
  const s = String(t || "").trim();
  if (s.length < 4) return false;
  const hasNumber = /\d/.test(s);
  const words = s.split(/\s+/).filter(Boolean);
  const hasTwoWords = words.length >= 2;
  const hasColWord = /(col\.?|colonia|fracc\.?|fraccionamiento|barrio|centro)/i.test(s);
  // "Hidalgo" solo: NO
  if (!hasTwoWords && !hasNumber) return false;
  return hasColWord || hasNumber || (hasTwoWords && s.length > 10);
}

/** Mensajes base (humanos) */
function intro(phoneE164) {
  if (templates && pick) return pick(templates.contrato_intro, phoneE164)();
  return (
    "Perfecto 🙌 Para revisar cobertura necesito tu *colonia* y tu *calle con número*.\n" +
    "Ejemplo: “Centro, Hidalgo 311”.\n\n" +
    "¿En qué colonia estás?"
  );
}

function askColoniaMoreDetail(phoneE164) {
  if (templates && pick) return pick(templates.ask_colonia_more_detail, phoneE164)();
  return "Gracias. ¿Me dices la *colonia* también? Con colonia + calle + número lo reviso rápido.";
}

function confirmColonia(col, phoneE164) {
  if (templates && pick) return pick(templates.confirm_colonia, phoneE164)(col);
  return `Perfecto, entonces estás en *${col}*. ¿Correcto?`;
}

async function handle({ session, inbound, send, updateSession, closeSession }) {
  const step = Number(session.step || 1);
  const data = session.data || {};
  const phoneE164 = session.phone_e164 || inbound.phoneE164;

  // STEP 1: dirección/colonia
  if (step === 1) {
    const txt = String(inbound.text || "").trim();

    // Saludos / mensajes muy cortos / solo calle sin número:
    if (!hasMinLen(txt, 3)) {
      await send(intro(phoneE164));
      return;
    }

    // Si no parece dirección, no uses LLM: pregunta colonia
    if (!looksLikeAddress(txt)) {
      await send(askColoniaMoreDetail(phoneE164));
      return;
    }

    // Intenta extraer colonia con LLM (pero ya no rompe si viene null)
    let hint = null;
    try {
      hint = await extractColoniaHint(txt);
    } catch {
      hint = null;
    }

    const queryText = (hint && hint.colonia_norm_guess) ? hint.colonia_norm_guess : txt;

    const match = await findColoniaMatch(queryText);

    if (!match || !match.found || !match.match) {
      await send(
        "No alcancé a identificar bien la colonia 😅\n" +
        "¿Me la puedes escribir tal cual? Ej: *Centro*, *Las Flores*, *Los Altos Residencial*…"
      );
      return;
    }

    // Guardamos match
    const nextData = {
      ...data,
      colonia_input: txt,
      colonia: match.match.colonia,
      cobertura: match.match.cobertura,
      zona: match.match.zona || null,
      // bandera para confirmar colonia una vez
      colonia_confirmed: false
    };

    // Confirmación humana primero
    await updateSession({ step: 10, data: nextData });
    await send(confirmColonia(match.match.colonia, phoneE164));
    return;
  }

  // STEP 10: confirmación de colonia (sí/no)
  if (step === 10) {
    const t = String(inbound.text || "").trim().toLowerCase();

    if (/(si|sí|correcto|asi es|exacto|ok|va|confirmo)/i.test(t)) {
      const confirmedData = { ...data, colonia_confirmed: true };

      // si NO hay cobertura
      if (String(confirmedData.cobertura || "").toUpperCase() === "NO") {
        await updateSession({ step: 99, data: confirmedData });
        await send(
          `Gracias. Por ahora *no tenemos cobertura* en *${confirmedData.colonia}*.\n` +
          "Si gustas, dime tu *nombre* y un *teléfono de contacto* y te avisamos cuando llegue 🙏"
        );
        return;
      }

      await updateSession({ step: 2, data: confirmedData });
      await send("Excelente ✅ ¿Cuál es tu *nombre completo*?");
      return;
    }

    if (/(no|nel|incorrecto|equivocado)/i.test(t)) {
      await updateSession({ step: 1, data: { ...data, colonia_confirmed: false } });
      await send("Va, corrígeme por favor 🙂 ¿Cuál es tu *colonia* y tu *calle con número*?");
      return;
    }

    // Si responde otra cosa, seguimos pidiendo confirmación clara
    await send("¿Me confirmas si esa colonia es correcta? Responde *sí* o *no* 🙂");
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
    const t = raw.toLowerCase();

    let tel = null;

    // 1) “mismo”
    if (t.includes("mismo")) {
      tel = phoneE164;
    }

    // 2) 10 dígitos MX
    if (!tel && looksLikePhone10MX(raw)) {
      tel = normalizeMX10ToE164(raw);
    }

    // 3) LLM fallback (si lo tienes activo)
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
      "En breve te contactamos para confirmar la instalación. 🙌"
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

  // fallback
  await closeSession(session.session_id);
  await send("Listo ✅ Si necesitas algo más, aquí estoy.");
}

module.exports = { intro, handle };