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

// ✅ PRO: .enc -> decrypt WhatsApp -> subir a R2 -> URL pública
const { resolveAndStoreMedia } = require("../../services/mediaService");

// ✅ Para evitar que replies/templates te cambien textos sin querer
const USE_TEMPLATES = false;
let templates, pick;
if (USE_TEMPLATES) {
  try {
    ({ templates, pick } = require("../../utils/replies"));
  } catch {}
}

// =====================
// Copy
// =====================
function intro() {
  if (templates && pick) return pick(templates.contrato_intro, "seed")();
  return "Perfecto 🙌 Para revisar cobertura, dime tu *colonia*.\nEjemplo: “Centro”.";
}

function askColonia() {
  if (templates && pick) return pick(templates.ask_colonia_more_detail, "seed")();
  return "¿Me dices tu *colonia*? (Ej: Centro, Las Américas, Morelos)";
}

function confirmColonia(col) {
  if (templates && pick) return pick(templates.confirm_colonia, "seed")(col);
  return `¿Te refieres a la colonia *${col}*? Responde *sí* o *no* 🙂`;
}

function looksLikeYes(t) {
  return /(si|sí|correcto|asi es|así es|exacto|ok|va|confirmo)/i.test(String(t || "").trim());
}
function looksLikeNo(t) {
  return /(no|nel|incorrecto|equivocado|error)/i.test(String(t || "").trim());
}

// =====================
// Media helpers
// =====================
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
    fileLength: first?.fileLength || null,
    width: first?.width || null,
    height: first?.height || null,
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

  // =====================
  // STEP 1: SOLO COLONIA
  // =====================
  if (step === 1) {
    if (!hasMinLen(txt, 2)) {
      await send(intro());
      return;
    }

    const coloniaRaw = txt;
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
      await updateSession({ step: 11, data: nextData });
      await send(`Perfecto ✅ Colonia *${nextData.colonia}*.\nAhora dime tu *calle y número* (Ej: Hidalgo 311).`);
      return;
    }

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
  // STEP 10: confirmar colonia
  // =====================
  if (step === 10) {
    if (looksLikeYes(txt)) {
      const colonia = data.colonia_guess;
      const nextData = { ...data, colonia, colonia_confirmed: true };
      await updateSession({ step: 11, data: nextData });
      await send(`Listo ✅ Colonia *${colonia}*.\nAhora dime tu *calle y número* (Ej: Hidalgo 311).`);
      return;
    }

    if (looksLikeNo(txt)) {
      await updateSession({
        step: 1,
        data: { ...data, colonia_guess: null, colonia_candidates: null },
      });
      await send("Va 🙂 dime tu *colonia* (Ej: Centro, Las Américas, Morelos).");
      return;
    }

    await send("¿Me confirmas con *sí* o *no*? 🙂");
    return;
  }

  // =====================
  // STEP 11: SOLO CALLE + NÚMERO
  // =====================
  if (step === 11) {
    if (!/\d/.test(txt) || txt.length < 4) {
      await send("¿Me lo mandas como *calle y número*? Ej: “Hidalgo 311” 🙂");
      return;
    }

    await updateSession({ step: 2, data: { ...data, calle_numero: txt } });
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

    // 👇 Copy premium: instrucción clara SIN sonar “reenvía”
    await send(
      "Listo ✅ Ahora envíame la foto de tu *INE (frente)* 📸\n" +
        "• Con buena luz\n" +
        "• Sin reflejos\n" +
        "• Que se lean datos y número"
    );
    return;
  }

  // STEP 4: INE frente (decrypt .enc -> R2)
  if (step === 4) {
    if (!hasMediaUrls(inbound.media)) {
      await send("Necesito la *foto del frente* de la INE 📸 (envíala como imagen, porfa)");
      return;
    }

    const m = pickMedia(inbound.media);

    // Guardrail: si faltan campos, no rompas UX
    if (!m.url || !m.mimetype || !m.mediaKey) {
      await notifyAdmin(
        `⚠️ CONTRATO INE FRENTE - MEDIA INCOMPLETA\n` +
          `Tel: ${phoneE164}\n` +
          `url: ${m.url || "N/A"}\n` +
          `mime: ${m.mimetype || "N/A"}\n` +
          `hasMediaKey: ${m.mediaKey ? "YES" : "NO"}`
      );

      await send("Recibido ✅ Estoy validando tu INE. Si hace falta algo, te aviso por aquí.");
      return;
    }

    const resolved = await resolveAndStoreMedia({
      providerUrl: m.url,
      mediaKey: m.mediaKey,
      mime: m.mimetype,
      phoneE164,
      kind: "image",
      folder: "contracts/ine",
      filenamePrefix: "ine_frente",
    });

    if (!resolved?.publicUrl) {
      await notifyAdmin(
        `⚠️ CONTRATO INE FRENTE - DECRYPT/STORE FAIL\n` +
          `Tel: ${phoneE164}\n` +
          `reason: ${resolved?.reason || "unknown"}\n` +
          `source: ${resolved?.source || "unknown"}\n` +
          `macOk: ${String(resolved?.macOk ?? "n/a")}\n` +
          `err: ${resolved?.err || "N/A"}`
      );

      await send("Recibido ✅ Estoy validando tu INE. Si necesito una confirmación adicional, te aviso por aquí.");
      return;
    }

    await updateSession({
      step: 5,
      data: {
        ...data,
        ine_frente_url: resolved.publicUrl,
        ine_frente_mime: resolved.contentType || m.mimetype || null,
        ine_frente_source_url: m.url,
      },
    });

    await send(
      "Gracias ✅ Ahora envíame la foto de tu *INE (atrás)* 📸\n" +
        "• Que se lean los números\n" +
        "• Sin reflejos\n" +
        "• Completa dentro del encuadre"
    );
    return;
  }

  // STEP 5: INE reverso (decrypt .enc -> R2 -> createContract)
  if (step === 5) {
    if (!hasMediaUrls(inbound.media)) {
      await send("Necesito la *foto de atrás* de la INE 📸 (envíala como imagen, porfa)");
      return;
    }

    const m = pickMedia(inbound.media);

    if (!m.url || !m.mimetype || !m.mediaKey) {
      await notifyAdmin(
        `⚠️ CONTRATO INE REVERSO - MEDIA INCOMPLETA\n` +
          `Tel: ${phoneE164}\n` +
          `url: ${m.url || "N/A"}\n` +
          `mime: ${m.mimetype || "N/A"}\n` +
          `hasMediaKey: ${m.mediaKey ? "YES" : "NO"}`
      );

      await send("Recibido ✅ Estoy validando tu INE (atrás). Si hace falta algo, te aviso por aquí.");
      return;
    }

    // anti duplicado por URL
    const sameUrl =
      data.ine_frente_source_url && m.url && String(m.url) === String(data.ine_frente_source_url);
    if (sameUrl) {
      // aquí sí conviene pedir otra, pero en tono premium:
      await send("Creo que me llegó la misma foto del *frente*. Para completar el trámite necesito la INE *por atrás* 📸");
      return;
    }

    const resolved = await resolveAndStoreMedia({
      providerUrl: m.url,
      mediaKey: m.mediaKey,
      mime: m.mimetype,
      phoneE164,
      kind: "image",
      folder: "contracts/ine",
      filenamePrefix: "ine_reverso",
    });

    if (!resolved?.publicUrl) {
      await notifyAdmin(
        `⚠️ CONTRATO INE REVERSO - DECRYPT/STORE FAIL\n` +
          `Tel: ${phoneE164}\n` +
          `reason: ${resolved?.reason || "unknown"}\n` +
          `source: ${resolved?.source || "unknown"}\n` +
          `macOk: ${String(resolved?.macOk ?? "n/a")}\n` +
          `err: ${resolved?.err || "N/A"}`
      );

      await send("Recibido ✅ Estoy validando tu INE (atrás). Si necesito confirmación adicional, te aviso por aquí.");
      return;
    }

    const finalData = {
      ...data,
      ine_reverso_url: resolved.publicUrl,
      ine_reverso_mime: resolved.contentType || m.mimetype || null,
      ine_reverso_source_url: m.url,
    };

    const c = await createContract({
      phoneE164,
      nombre: finalData.nombre,
      colonia: finalData.colonia,
      calle_numero: finalData.calle_numero,
      telefono_contacto: finalData.telefono_contacto,
      ine_frente_url: finalData.ine_frente_url,
      ine_reverso_url: finalData.ine_reverso_url,
      ine_frente_mime: finalData.ine_frente_mime,
      ine_reverso_mime: finalData.ine_reverso_mime,
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

  await closeSession(session.session_id);
  await send("Listo ✅ Si necesitas algo más, aquí estoy.");
}

module.exports = { intro, handle };