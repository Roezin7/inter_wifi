// src/handlers/flows/contrato.js
const {
  hasMinLen,
  looksLikePhone10MX,
  normalizeMX10ToE164,
  hasMediaUrls
} = require("../../utils/validators");

const { createContract } = require("../../services/contractsService");
const { notifyAdmin, buildNewContractAdminMsg } = require("../../services/notifyService");
const { parsePhoneE164 } = require("../../services/llmService");
const { resolveColonia } = require("../../services/coverageService");

// Variación opcional
let templates, pick;
try {
  ({ templates, pick } = require("../../utils/replies"));
} catch {}

// =====================
// Helpers
// =====================
function looksLikeAddress(text) {
  const s = String(text || "").trim();
  if (s.length < 3) return false;

  const hasNumber = /\d/.test(s);
  const hasComma = s.includes(",");
  const hasColWord = /(col\.?|colonia|fracc\.?|fraccionamiento|barrio|centro)/i.test(s);

  const words = s.split(/\s+/).filter(Boolean);
  if (words.length === 1 && !hasNumber) return false;

  if (hasComma || hasNumber || hasColWord) return true;
  if (words.length >= 2 && s.length >= 10) return true;

  return false;
}

function intro(seed) {
  if (templates && pick) return pick(templates.contrato_intro, seed)();
  return (
    "Va, te ayudo con la contratación 🙌\n" +
    "Para revisar cobertura, ¿me compartes *colonia* y *calle con número*?\n" +
    "Ejemplo: “Centro, Hidalgo 311”."
  );
}

function askColonia(seed) {
  if (templates && pick) return pick(templates.ask_colonia_more_detail, seed)();
  return "Gracias. ¿Me dices la *colonia*? (Ej: Centro, Las Américas, Morelos)";
}

function confirmColonia(col, seed) {
  if (templates && pick) return pick(templates.confirm_colonia, seed)(col);
  return `¿Te refieres a la colonia *${col}*? Responde *sí* o *no* 🙂`;
}

// Extrae url + (si existe) id/mime de un media.
// Mantiene compatibilidad con tu inbound.media actual.
function pickMedia(inboundMedia) {
  const urls = inboundMedia?.urls || [];
  const items = inboundMedia?.items || []; // por si en el futuro agregas items
  const first = items?.[0] || null;

  return {
    url: first?.url || urls?.[0] || null,
    id: first?.id || inboundMedia?.id || null,
    mimetype: first?.mimetype || inboundMedia?.mimetype || null
  };
}

// =====================
// Flow
// =====================
async function handle({ session, inbound, send, updateSession, closeSession }) {
  const step = Number(session.step || 1);
  const data = session.data || {};
  const phoneE164 = session.phone_e164 || inbound.phoneE164;
  const txt = String(inbound.text || "").trim();

  // STEP 1: resolver colonia (DB-first)
  if (step === 1) {
    if (!hasMinLen(txt, 2)) {
      await send(intro(phoneE164));
      return;
    }

    const res = await resolveColonia(txt, { limit: 5 });

    if (!res.ok) {
      // si mandó "Hidalgo 311" sin colonia, pide colonia
      if (looksLikeAddress(txt) && !/(col\.?|colonia|centro|morelos|americ)/i.test(txt)) {
        await send("¿En qué *colonia* queda esa calle? (Ej: Centro)");
        return;
      }
      await send(askColonia(phoneE164));
      return;
    }

    // si es suficientemente claro, aceptamos y pedimos calle+número
    if (res.autoAccept) {
      const nextData = {
        ...data,
        colonia_input: txt,
        colonia: res.best.colonia,
        colonia_confirmed: true
      };
      await updateSession({ step: 11, data: nextData });
      await send(
        `Perfecto ✅ Colonia *${nextData.colonia}*.\n` +
          `¿Me pasas tu *calle y número*? (Ej: Hidalgo 311)`
      );
      return;
    }

    // si hay duda, pedimos confirmación con el mejor match
    const nextData = {
      ...data,
      colonia_input: txt,
      colonia_guess: res.best.colonia,
      colonia_candidates: res.candidates
    };
    await updateSession({ step: 10, data: nextData });
    await send(confirmColonia(res.best.colonia, phoneE164));
    return;
  }

  // STEP 10: confirmar colonia
  if (step === 10) {
    const t = txt.toLowerCase();
    const isYes = /(si|sí|correcto|asi es|así es|exacto|ok|va|confirmo)/i.test(t);
    const isNo = /(no|nel|incorrecto|equivocado|error)/i.test(t);

    if (isYes) {
      const nextData = {
        ...data,
        colonia: data.colonia_guess,
        colonia_confirmed: true
      };
      await updateSession({ step: 11, data: nextData });
      await send(
        `Listo ✅ Colonia *${nextData.colonia}*.\n` +
          `¿Me pasas tu *calle y número*? (Ej: Hidalgo 311)`
      );
      return;
    }

    if (isNo) {
      await updateSession({ step: 1, data: { ...data, colonia_guess: null } });
      await send("Va 🙂 dime tu *colonia* (Ej: Centro, Las Américas, Morelos).");
      return;
    }

    await send("¿Me confirmas con *sí* o *no*? 🙂");
    return;
  }

  // STEP 11: calle + número
  if (step === 11) {
    if (!/\d/.test(txt) || txt.length < 4) {
      await send(`¿Me lo mandas como *calle y número*? Ej: “Hidalgo 311” 🙂`);
      return;
    }

    const nextData = { ...data, calle_numero: txt };
    await updateSession({ step: 2, data: nextData });
    await send("Excelente ✅ ¿Cuál es tu *nombre completo*?");
    return;
  }

  // STEP 2: nombre
  if (step === 2) {
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
    const raw = txt;
    const lower = raw.toLowerCase();
    let tel = null;

    if (lower.includes("mismo")) tel = phoneE164;
    if (!tel && looksLikePhone10MX(raw)) tel = normalizeMX10ToE164(raw);

    if (!tel) {
      try {
        const parsed = await parsePhoneE164(raw, phoneE164);
        tel = parsed?.phone_e164 || null;
      } catch {}
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

    const m = pickMedia(inbound.media);
    if (!m.url) {
      await send("No pude leer la imagen 😅 ¿Me la reenvías como *foto*?");
      return;
    }

    await updateSession({
      step: 5,
      data: {
        ...data,
        ine_frente_url: m.url,
        ine_frente_media_id: m.id || null,
        ine_frente_mime: m.mimetype || null
      }
    });

    await send("Gracias. Ahora envíame la foto de tu *INE (atrás)* 📸");
    return;
  }

  // STEP 5: INE atrás + crear contrato
  if (step === 5) {
    if (!hasMediaUrls(inbound.media)) {
      await send("Necesito la *foto de atrás* de la INE 📸 (envíala como imagen, porfa)");
      return;
    }

    const m = pickMedia(inbound.media);
    if (!m.url) {
      await send("No pude leer la imagen 😅 ¿Me la reenvías como *foto*?");
      return;
    }

    // ✅ Anti-duplicado (mismo archivo que el frente)
    const sameUrl = data.ine_frente_url && m.url === data.ine_frente_url;
    const sameId =
      data.ine_frente_media_id && m.id && String(m.id) === String(data.ine_frente_media_id);

    if (sameUrl || sameId) {
      await send(
        "Me llegó la misma imagen que la del *frente* 😅\n" +
          "¿Me reenvías la foto de la INE *por atrás*? 📸"
      );
      return;
    }

    const finalData = {
      ...data,
      ine_reverso_url: m.url,
      ine_reverso_media_id: m.id || null,
      ine_reverso_mime: m.mimetype || null
    };

    const c = await createContract({
      phoneE164,
      nombre: finalData.nombre,
      colonia: finalData.colonia,
      calle_numero: finalData.calle_numero, // ✅
      telefono_contacto: finalData.telefono_contacto,
      ine_frente_url: finalData.ine_frente_url,
      ine_reverso_url: finalData.ine_reverso_url,
      // opcionales (solo si tu DB/insert los soporta)
      ine_frente_media_id: finalData.ine_frente_media_id,
      ine_reverso_media_id: finalData.ine_reverso_media_id,
      ine_frente_mime: finalData.ine_frente_mime,
      ine_reverso_mime: finalData.ine_reverso_mime
    });

    // ✅ Notificación admin PRO (y que se vea bonito en WhatsApp)
    await notifyAdmin(buildNewContractAdminMsg(c));

    // ✅ Cierra sesión ANTES del último send para evitar “proceso abierto” si falla el envío
    await closeSession(session.session_id);

    await send(
      `Listo ✅ Ya quedó tu solicitud.\n` +
        `Folio: *${c.folio}*\n\n` +
        "En breve te contactamos para confirmar la instalación 🙌"
    );
    return;
  }

  // fallback
  await closeSession(session.session_id);
  await send("Listo ✅ Si necesitas algo más, aquí estoy.");
}

module.exports = { intro, handle };