// src/handlers/flows/contrato.js
const {
  hasMinLen,
  looksLikePhone10MX,
  normalizeMX10ToE164,
  hasMediaUrls,
} = require("../../utils/validators");

const { createContract } = require("../../services/contractsService");
const { notifyAdmin, buildNewContractAdminMsg } = require("../../services/notifyService");
const { parsePhoneE164, extractColoniaHint } = require("../../services/llmService");
const { resolveColonia } = require("../../services/coverageService");
const { storeToR2 } = require("../../services/r2UploadService");
const { pickInboundMedia } = require("../../utils/inboundMedia");
const { logger } = require("../../utils/logger");

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
function intro() {
  if (templates && pick) return pick(templates.contrato_intro, "seed")();
  return "Perfecto. Para revisar cobertura necesito tu *colonia*.";
}

function askColonia() {
  if (templates && pick) return pick(templates.ask_colonia_more_detail, "seed")();
  return "Compárteme tu *colonia* para revisar cobertura.";
}

function confirmColonia(col) {
  if (templates && pick) return pick(templates.confirm_colonia, "seed")(col);
  return `¿Te refieres a la colonia *${col}*? Responde *sí* o *no*.`;
}

function looksLikeYes(t) {
  return /(si|sí|correcto|asi es|así es|exacto|ok|va|confirmo)/i.test(String(t || "").trim());
}
function looksLikeNo(t) {
  return /(no|nel|incorrecto|equivocado|error)/i.test(String(t || "").trim());
}

function looksLikeContractIntent(text) {
  return /(contrat|quiero internet|nuevo servicio|instal|cobertura)/i.test(String(text || "").trim());
}

function pickColoniaInput(text, guess) {
  const raw = String(text || "").trim();
  if (guess) return String(guess).trim();

  if (raw.includes(",")) {
    const first = raw.split(",")[0];
    if (first) return String(first).trim();
  }

  return raw;
}

function buildManualColoniaCaptureMsg(colonia) {
  return (
    `Gracias 😊 Tomo la colonia como *${colonia}*.\n` +
    "La revisaremos al validar la solicitud.\n\n" +
    "Ahora compárteme tu *calle y número*."
  );
}

// Copy: tips para foto (profesional, sin sonar “regaño”)
function inePhotoTips(sideLabel) {
  return (
    `📸 *INE (${sideLabel})*\n` +
    `• Buena luz (sin sombras)\n` +
    `• Sin reflejos / sin flash directo\n` +
    `• Enfoque nítido (que se lea el texto)\n` +
    `• Completa dentro del cuadro (sin recortar esquinas)\n` +
    `• Fondo liso y sin movimiento`
  );
}

// =====================
// Flow
// =====================
async function handle({
  session,
  inbound,
  send,
  updateSession,
  closeSession,
  dbClient,
  notifyAdmin: notifyAdminFn,
}) {
  const step = Number(session.step || 1);
  const data = session.data || {};
  const phoneE164 = session.phone_e164 || inbound.phoneE164;
  const txt = String(inbound.text || "").trim();

  // =====================
  // STEP 1: SOLO COLONIA (sin mezclar con dirección)
  // =====================
  if (step === 1) {
    if (!hasMinLen(txt, 2)) {
      await send(intro());
      return;
    }

    if (looksLikeContractIntent(txt) && !/\d/.test(txt)) {
      await send("Con gusto. Para revisar cobertura necesito que me compartas tu *colonia*.");
      return;
    }

    let coloniaGuess = "";
    if (/[,\d]/.test(txt) || txt.split(" ").length >= 4) {
      try {
        const hint = await extractColoniaHint(txt);
        coloniaGuess = String(hint?.colonia_norm_guess || "").trim();
      } catch {}
    }

    const coloniaRaw = pickColoniaInput(txt, coloniaGuess);

    // Resolver colonia contra DB
    const res = await resolveColonia(coloniaRaw, { limit: 5 });

    if (!res?.ok) {
      const looksLikeAddress = /[,\d]/.test(txt);

      if (looksLikeAddress && !coloniaGuess) {
        await send("Para ubicar bien la cobertura, primero necesito que me compartas solo la *colonia*.");
        return;
      }

      const nextData = {
        ...data,
        colonia_input: coloniaRaw,
        colonia: coloniaRaw,
        colonia_confirmed: true,
        cobertura: "POR_VALIDAR",
        zona: null,
        coverage_source: "manual_unlisted",
      };

      await updateSession({ step: 11, data: nextData });
      await send(buildManualColoniaCaptureMsg(nextData.colonia));
      return;
    }

    // ✅ Si está claro, NO pedir colonia dos veces
    if (res.autoAccept) {
      const nextData = {
        ...data,
        colonia_input: coloniaRaw,
        colonia: res.best.colonia,
        colonia_confirmed: true,
        cobertura: "SI",
        zona: null,
        coverage_source: "db_auto",
      };

      await updateSession({ step: 11, data: nextData });
      await send(
        `Perfecto ✅ Colonia *${nextData.colonia}*.\n` +
          "Ahora compárteme tu *calle y número*."
      );
      return;
    }

    // ✅ Si hay duda, pedimos confirmación (esto NO es “pedir colonia otra vez”, es confirmar)
    const nextData = {
      ...data,
      colonia_input: coloniaRaw,
      colonia_guess: res.best.colonia,
      colonia_candidates: res.candidates,
    };

    await updateSession({ step: 10, data: nextData });
    await send(confirmColonia(res.best.colonia));
    return;
  }

  // =====================
  // STEP 10: confirmar colonia (solo si hubo duda)
  // =====================
  if (step === 10) {
    if (looksLikeYes(txt)) {
      const colonia = data.colonia_guess;

      const nextData = { ...data, colonia, colonia_confirmed: true };
      nextData.cobertura = "SI";
      nextData.zona = null;
      nextData.coverage_source = "db_confirmed";
      await updateSession({ step: 11, data: nextData });

      await send(
        `Listo ✅ Colonia *${colonia}*.\n` +
          "Ahora compárteme tu *calle y número*."
      );
      return;
    }

    if (looksLikeNo(txt)) {
      // aquí sí regresamos a step 1 para que nos diga colonia correcta
      await updateSession({
        step: 1,
        data: { ...data, colonia_guess: null, colonia_candidates: null },
      });
      await send("De acuerdo. Compárteme tu *colonia* para revisarla de nuevo.");
      return;
    }

    await send("Por favor confírmame con *sí* o *no*.");
    return;
  }

  // =====================
  // STEP 11: SOLO CALLE + NÚMERO
  // =====================
  if (step === 11) {
    if (!/\d/.test(txt) || txt.length < 4) {
      await send("Compárteme la *calle y número* del domicilio.");
      return;
    }

    const nextData = { ...data, calle_numero: txt };
    await updateSession({ step: 2, data: nextData });
    await send("Gracias. Ahora compárteme tu *nombre completo*.");
    return;
  }

  // =====================
  // STEP 2: nombre
  // =====================
  if (step === 2) {
    if (!hasMinLen(txt, 3)) {
      await send("Necesito tu *nombre completo* para continuar.");
      return;
    }

    await updateSession({ step: 3, data: { ...data, nombre: txt } });
    await send("Perfecto. ¿Qué *teléfono de contacto* dejamos? Puedes escribir *mismo* si quieres usar este número.");
    return;
  }

  // =====================
  // STEP 3: teléfono
  // =====================
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
      await send("Compárteme un teléfono de *10 dígitos* o escribe *mismo*.");
      return;
    }

    await updateSession({ step: 4, data: { ...data, telefono_contacto: tel } });
    await send(
      "Gracias. Ahora envíame la foto de tu *INE por el frente*.\n\n" +
        inePhotoTips("frente")
    );
    return;
  }

  // =====================
  // STEP 4: INE frente (subir a R2)
  // =====================
  if (step === 4) {
    if (!hasMediaUrls(inbound.media)) {
      await send(
        "Necesito la *foto del frente* de tu INE.\n\n" +
          inePhotoTips("frente")
      );
      return;
    }

    const m = pickInboundMedia(inbound.media);

    if (!m.url) {
      await send("No pude leer la imagen. Reenvíamela como *foto*, por favor.\n\n" + inePhotoTips("frente"));
      return;
    }

    // 🔥 CLAVE: para descifrar .enc se necesita mediaKey + mimetype
    if (!m.mediaKey || !m.mimetype) {
      logger.error("[CONTRATO][INE_FRENTE] missing mediaKey/mimetype", {
        hasUrl: !!m.url,
        hasMediaKey: !!m.mediaKey,
        mimetype: m.mimetype,
      });
      await send(
        "No pude procesar esa imagen. Reenvíala como *foto*, por favor.\n\n" +
          inePhotoTips("frente")
      );
      return;
    }

    let uploaded;
    try {
      uploaded = await storeToR2({
        url: m.url,
        mediaKey: m.mediaKey,
        mimetype: m.mimetype,
        fileName: m.fileName,
        folder: "contracts/ine",
        filenamePrefix: "ine_frente",
        phoneE164,
      });
    } catch (e) {
      logger.error("[CONTRATO][INE_FRENTE] storeToR2 failed", e?.message || e);
      await send(
        "Tuve un problema guardando la imagen. Reenvíamela, por favor.\n\n" +
          inePhotoTips("frente")
      );
      return;
    }

    await updateSession({
      step: 5,
      data: {
        ...data,
        ine_frente_url: uploaded.publicUrl, // ✅ pública (no .enc)
        ine_frente_media_id: m.id || null,
        ine_frente_mime: uploaded.contentType || m.mimetype || null,
        ine_frente_source_url: m.url, // auditoría
        ine_frente_source_mediaKey: m.mediaKey, // auditoría
      },
    });

    await send(
      "Gracias. Ahora envíame la foto de tu *INE por atrás*.\n\n" +
        inePhotoTips("atrás")
    );
    return;
  }

  // =====================
  // STEP 5: INE atrás + crear contrato (subir a R2)
  // =====================
  if (step === 5) {
    if (!hasMediaUrls(inbound.media)) {
      await send(
        "Necesito la *foto por atrás* de tu INE.\n\n" +
          inePhotoTips("atrás")
      );
      return;
    }

    const m = pickInboundMedia(inbound.media);

    if (!m.url) {
      await send("No pude leer la imagen. Reenvíamela como *foto*, por favor.\n\n" + inePhotoTips("atrás"));
      return;
    }

    if (!m.mediaKey || !m.mimetype) {
      logger.error("[CONTRATO][INE_REVERSO] missing mediaKey/mimetype", {
        hasUrl: !!m.url,
        hasMediaKey: !!m.mediaKey,
        mimetype: m.mimetype,
      });
      await send(
        "No pude procesar esa imagen. Reenvíala como *foto*, por favor.\n\n" +
          inePhotoTips("atrás")
      );
      return;
    }

    // anti duplicado (por id/url)
    const sameId =
      data.ine_frente_media_id && m.id && String(m.id) === String(data.ine_frente_media_id);
    const sameUrl =
      data.ine_frente_source_url && m.url && String(m.url) === String(data.ine_frente_source_url);

    if (sameId || sameUrl) {
      await send(
        "Me llegó la misma imagen que la del *frente*.\n" +
          "Reenvíame la foto de la INE *por atrás*, por favor.\n\n" +
          inePhotoTips("atrás")
      );
      return;
    }

    let uploaded;
    try {
      uploaded = await storeToR2({
        url: m.url,
        mediaKey: m.mediaKey,
        mimetype: m.mimetype,
        fileName: m.fileName,
        folder: "contracts/ine",
        filenamePrefix: "ine_reverso",
        phoneE164,
      });
    } catch (e) {
      logger.error("[CONTRATO][INE_REVERSO] storeToR2 failed", e?.message || e);
      await send(
        "Tuve un problema guardando la imagen. Reenvíamela, por favor.\n\n" +
          inePhotoTips("atrás")
      );
      return;
    }

    const finalData = {
      ...data,
      ine_reverso_url: uploaded.publicUrl, // ✅ pública
      ine_reverso_media_id: m.id || null,
      ine_reverso_mime: uploaded.contentType || m.mimetype || null,
      ine_reverso_source_url: m.url,
      ine_reverso_source_mediaKey: m.mediaKey,
    };

    const c = await createContract(
      {
        phoneE164,
        nombre: finalData.nombre,
        colonia: finalData.colonia,
        calle_numero: finalData.calle_numero,
        cobertura: finalData.cobertura,
        zona: finalData.zona,
        telefono_contacto: finalData.telefono_contacto,

        ine_frente_url: finalData.ine_frente_url,
        ine_reverso_url: finalData.ine_reverso_url,

        // opcionales
        ine_frente_media_id: finalData.ine_frente_media_id,
        ine_reverso_media_id: finalData.ine_reverso_media_id,
        ine_frente_mime: finalData.ine_frente_mime,
        ine_reverso_mime: finalData.ine_reverso_mime,
      },
      dbClient
    );

    await (notifyAdminFn || notifyAdmin)(buildNewContractAdminMsg(c));
    await closeSession(session.session_id);

    await send(
      `Listo. Ya quedó registrada tu solicitud.\n` +
        `Folio: *${c.folio}*\n\n` +
        "En breve nos comunicaremos contigo para continuar con la instalación."
    );
    return;
  }

  // fallback
  await closeSession(session.session_id);
  await send("Listo. Si necesitas algo más, aquí estoy.");
}

module.exports = { intro, handle };
