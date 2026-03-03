// src/handlers/flows/contrato.js
const {
  hasMinLen,
  looksLikePhone10MX,
  normalizeMX10ToE164,
  hasMediaUrls,
} = require("../../utils/validators");

const { createContract } = require("../../services/contractsService");
const { notifyAdmin, buildNewContractAdminMsg } = require("../../services/notifyService");
const { parsePhoneE164 } = require("../../services/llmService");
const { resolveColonia } = require("../../services/coverageService");

const {
  resolveAndStoreMedia,
  ineQualityMessage,
} = require("../../services/mediaService");

// ✅ Para evitar que replies/templates te cambien textos sin querer
const USE_TEMPLATES = false;
let templates, pick;
if (USE_TEMPLATES) {
  try {
    ({ templates, pick } = require("../../utils/replies"));
  } catch {}
}

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

/**
 * Permite:
 * - "Centro, Hidalgo 311" -> colonia=Centro, calleNum=Hidalgo 311
 * - "Centro Hidalgo 311" -> heurística: colonia=Centro, calleNum=Hidalgo 311
 * - "Centro" -> colonia=Centro, calleNum=""
 * - "Hidalgo 311" -> colonia="", calleNum="Hidalgo 311"
 */
function splitColoniaAndAddress(text) {
  const s = String(text || "").trim();
  if (!s) return { colonia: "", calleNum: "" };

  if (s.includes(",")) {
    const [a, b] = s.split(",").map((x) => x.trim());
    return { colonia: a || "", calleNum: b || "" };
  }

  const hasNumber = /\d/.test(s);
  const mentionsCol =
    /(col\.?|colonia|fracc\.?|fraccionamiento|barrio|centro|morelos|am[eé]ricas)/i.test(s);

  if (hasNumber && !mentionsCol) {
    return { colonia: "", calleNum: s };
  }

  if (hasNumber && s.length >= 8) {
    const parts = s.split(/\s+/).filter(Boolean);
    const colonia = parts[0] || "";
    const calleNum = parts.slice(1).join(" ");
    return { colonia, calleNum };
  }

  return { colonia: s, calleNum: "" };
}

function intro() {
  if (templates && pick) return pick(templates.contrato_intro, "seed")();
  return (
    "Perfecto 🙌 Para revisar cobertura, dime tu *colonia*.\n" +
    "Ejemplo: “Centro”.\n\n" +
    "Tip: también puedes mandar *colonia, calle y número* (ej: “Centro, Hidalgo 311”)."
  );
}

function askColonia() {
  if (templates && pick) return pick(templates.ask_colonia_more_detail, "seed")();
  return "¿Me dices tu *colonia*? (Ej: Centro, Las Américas, Morelos)";
}

function confirmColonia(col) {
  if (templates && pick) return pick(templates.confirm_colonia, "seed")(col);
  return `¿Te refieres a la colonia *${col}*? Responde *sí* o *no* 🙂`;
}

function pickMedia(inboundMedia) {
  const urls = inboundMedia?.urls || [];
  const items = inboundMedia?.items || [];
  const first = items?.[0] || null;

  return {
    url: first?.url || urls?.[0] || null,
    id: first?.id || inboundMedia?.id || null,
    mimetype: first?.mimetype || inboundMedia?.mimetype || null,
    mediaKey: first?.mediaKey || null,
    fileName: first?.fileName || null,
  };
}

function looksLikeYes(t) {
  return /(si|sí|correcto|asi es|así es|exacto|ok|va|confirmo)/i.test(String(t || "").trim());
}
function looksLikeNo(t) {
  return /(no|nel|incorrecto|equivocado|error)/i.test(String(t || "").trim());
}

// Mensaje pro (sin pedir reenviar “por reenviar”, sino “retomar foto”)
function askIneFront() {
  return (
    "Listo ✅ Ahora envíame foto de tu *INE (frente)* 📸\n\n" +
    "Tip rápido: buena luz, sin reflejos, y que se vean las 4 esquinas."
  );
}
function askIneBack() {
  return (
    "Gracias. Ahora envíame la foto de tu *INE (atrás)* 📸\n\n" +
    "Tip rápido: buena luz, sin reflejos, y que se vean las 4 esquinas."
  );
}

// =====================
// Flow
// =====================
async function handle({ session, inbound, send, updateSession, closeSession }) {
  const step = Number(session.step || 1);
  const data = session.data || {};
  const phoneE164 = session.phone_e164 || inbound.phoneE164;
  const txt = String(inbound.text || "").trim();

  // STEP 1: colonia (o colonia + calle/numero)
  if (step === 1) {
    if (!hasMinLen(txt, 2)) {
      await send(intro());
      return;
    }

    const { colonia: coloniaRaw, calleNum } = splitColoniaAndAddress(txt);

    if (!coloniaRaw && looksLikeAddress(txt)) {
      await send("¿En qué *colonia* queda esa calle? (Ej: Centro)");
      return;
    }

    const res = await resolveColonia(coloniaRaw, { limit: 5 });

    if (!res?.ok) {
      await send(askColonia());
      return;
    }

    if (res.autoAccept) {
      const nextData = {
        ...data,
        colonia_input: coloniaRaw,
        colonia: res.best.colonia,
        colonia_confirmed: true,
      };

      if (calleNum && /\d/.test(calleNum) && calleNum.length >= 4) {
        await updateSession({ step: 2, data: { ...nextData, calle_numero: calleNum } });
        await send(
          `Perfecto ✅ Colonia *${nextData.colonia}* y dirección *${calleNum}*.\n` +
            "Ahora, ¿cuál es tu *nombre completo*?"
        );
        return;
      }

      await updateSession({ step: 11, data: nextData });
      await send(
        `Perfecto ✅ Colonia *${nextData.colonia}*.\n` +
          "¿Me pasas tu *calle y número*? (Ej: Hidalgo 311)"
      );
      return;
    }

    const nextData = {
      ...data,
      colonia_input: coloniaRaw,
      colonia_guess: res.best.colonia,
      colonia_candidates: res.candidates,
      calle_numero_pending: calleNum || null,
    };

    await updateSession({ step: 10, data: nextData });
    await send(confirmColonia(res.best.colonia));
    return;
  }

  // STEP 10: confirmar colonia
  if (step === 10) {
    if (looksLikeYes(txt)) {
      const colonia = data.colonia_guess;
      const pending = String(data.calle_numero_pending || "").trim();

      if (pending && /\d/.test(pending)) {
        const nextData = {
          ...data,
          colonia,
          colonia_confirmed: true,
          calle_numero: pending,
        };
        await updateSession({ step: 2, data: nextData });
        await send(
          `Listo ✅ Colonia *${colonia}* y dirección *${pending}*.\n` +
            "Ahora, ¿cuál es tu *nombre completo*?"
        );
        return;
      }

      const nextData = { ...data, colonia, colonia_confirmed: true };
      await updateSession({ step: 11, data: nextData });
      await send(
        `Listo ✅ Colonia *${colonia}*.\n` +
          "¿Me pasas tu *calle y número*? (Ej: Hidalgo 311)"
      );
      return;
    }

    if (looksLikeNo(txt)) {
      await updateSession({
        step: 1,
        data: { ...data, colonia_guess: null, calle_numero_pending: null },
      });
      await send("Va 🙂 dime tu *colonia* (Ej: Centro, Las Américas, Morelos).");
      return;
    }

    await send("¿Me confirmas con *sí* o *no*? 🙂");
    return;
  }

  // STEP 11: calle + número
  if (step === 11) {
    if (!/\d/.test(txt) || txt.length < 4) {
      await send("¿Me lo mandas como *calle y número*? Ej: “Hidalgo 311” 🙂");
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
    await send(askIneFront());
    return;
  }

  // STEP 4: INE frente (validar + subir a R2)
  if (step === 4) {
    if (!hasMediaUrls(inbound.media)) {
      await send("Necesito la *foto del frente* de la INE 📸 (envíala como imagen, porfa)");
      return;
    }

    const m = pickMedia(inbound.media);

    if (!m.url) {
      await send("No pude leer la imagen 😅 Envíala como *foto* por favor.");
      return;
    }

    // Para .enc: necesitamos mediaKey + mimetype
    if (/\.enc(\?|$)/i.test(String(m.url)) && (!m.mediaKey || !m.mimetype)) {
      console.error("[CONTRATO][INE_FRENTE] missing mediaKey/mimetype", {
        hasUrl: !!m.url,
        hasMediaKey: !!m.mediaKey,
        mimetype: m.mimetype,
      });
      await send("No pude procesar esa imagen 😅 Envíala como *foto* por favor.");
      return;
    }

    // ✅ Resolver + validar INE antes de subir
    const out = await resolveAndStoreMedia({
      providerUrl: m.url,
      mediaId: m.id || null,
      mime: m.mimetype || "image/jpeg",
      mediaKey: m.mediaKey || null,
      phoneE164,
      kind: "contracts/ine",
      validateIne: true,
      forceUpload: true,
    });

    if (!out?.publicUrl) {
      // rechazo por calidad (pro, sin reenviar)
      if (out?.source === "quality_reject" && out?.quality?.reason) {
        await send(ineQualityMessage(out.quality.reason));
        return;
      }

      // problemas técnicos
      console.error("[CONTRATO][INE_FRENTE] resolveAndStoreMedia failed:", {
        source: out?.source,
        reason: out?.errorReason,
        err: out?.error,
      });

      await send(
        "Tuve un problema procesando la foto 😅\n" +
          "Por favor envíala nuevamente como *foto* (no documento)."
      );
      return;
    }

    await updateSession({
      step: 5,
      data: {
        ...data,
        ine_frente_url: out.publicUrl,
        ine_frente_media_id: m.id || null,
        ine_frente_mime: out.contentType || m.mimetype || null,
        ine_frente_quality: out.quality || null,
      },
    });

    await send(askIneBack());
    return;
  }

  // STEP 5: INE reverso (validar + crear contrato)
  if (step === 5) {
    if (!hasMediaUrls(inbound.media)) {
      await send("Necesito la *foto de atrás* de la INE 📸 (envíala como imagen, porfa)");
      return;
    }

    const m = pickMedia(inbound.media);

    if (!m.url) {
      await send("No pude leer la imagen 😅 Envíala como *foto* por favor.");
      return;
    }

    if (/\.enc(\?|$)/i.test(String(m.url)) && (!m.mediaKey || !m.mimetype)) {
      console.error("[CONTRATO][INE_REVERSO] missing mediaKey/mimetype", {
        hasUrl: !!m.url,
        hasMediaKey: !!m.mediaKey,
        mimetype: m.mimetype,
      });
      await send("No pude procesar esa imagen 😅 Envíala como *foto* por favor.");
      return;
    }

    // anti duplicado (por id/url)
    const sameId =
      data.ine_frente_media_id && m.id && String(m.id) === String(data.ine_frente_media_id);
    const sameUrl = data.ine_frente_url && m.url && String(m.url) === String(data.ine_frente_url);

    if (sameId || sameUrl) {
      await send(
        "Me llegó la misma foto que la del *frente* 😅\n\n" +
          "Envíame ahora la INE *por atrás* (que se vean las 4 esquinas y texto nítido)."
      );
      return;
    }

    const out = await resolveAndStoreMedia({
      providerUrl: m.url,
      mediaId: m.id || null,
      mime: m.mimetype || "image/jpeg",
      mediaKey: m.mediaKey || null,
      phoneE164,
      kind: "contracts/ine",
      validateIne: true,
      forceUpload: true,
    });

    if (!out?.publicUrl) {
      if (out?.source === "quality_reject" && out?.quality?.reason) {
        await send(ineQualityMessage(out.quality.reason));
        return;
      }

      console.error("[CONTRATO][INE_REVERSO] resolveAndStoreMedia failed:", {
        source: out?.source,
        reason: out?.errorReason,
        err: out?.error,
      });

      await send(
        "Tuve un problema procesando la foto 😅\n" +
          "Por favor envíala nuevamente como *foto* (no documento)."
      );
      return;
    }

    const finalData = {
      ...data,
      ine_reverso_url: out.publicUrl,
      ine_reverso_media_id: m.id || null,
      ine_reverso_mime: out.contentType || m.mimetype || null,
      ine_reverso_quality: out.quality || null,
    };

    const c = await createContract({
      phoneE164,
      nombre: finalData.nombre,
      colonia: finalData.colonia,
      calle_numero: finalData.calle_numero,
      telefono_contacto: finalData.telefono_contacto,

      ine_frente_url: finalData.ine_frente_url,
      ine_reverso_url: finalData.ine_reverso_url,

      // opcionales (auditoría)
      ine_frente_media_id: finalData.ine_frente_media_id,
      ine_reverso_media_id: finalData.ine_reverso_media_id,
      ine_frente_mime: finalData.ine_frente_mime,
      ine_reverso_mime: finalData.ine_reverso_mime,

      // telemetría pro (si tu DB lo soporta, si no, ignóralo)
      ine_frente_quality_score: finalData.ine_frente_quality?.score ?? null,
      ine_reverso_quality_score: finalData.ine_reverso_quality?.score ?? null,
    });

    await notifyAdmin(buildNewContractAdminMsg(c));

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