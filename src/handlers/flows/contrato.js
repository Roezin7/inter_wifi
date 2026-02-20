const { hasMinLen, looksLikePhone10MX, normalizeMX10ToE164, hasMediaUrls } = require("../../../utils/validators");
const { findColoniaMatch } = require("../../services/coverageService");
const { createContract } = require("../../services/contractsService");
const { notifyAdmin } = require("../../services/notifyService");
const { extractColoniaHint } = require("../../services/llmService");
const { parsePhoneE164 } = require("../../services/llmService");

function intro() {
  return (
    "Perfecto 👌 Para contratar solo te voy a pedir unos datos.\n\n" +
    "1) ¿En qué *colonia* y *calle* estás? (ej: Centro, Hidalgo 305)"
  );
}

async function handle({ session, inbound, send, updateSession, closeSession }) {
  const step = session.step || 1;
  const data = session.data || {};

  if (step === 1) {
    // Esperamos colonia/dirección
    if (!hasMinLen(inbound.text, 3)) {
      await send("¿Me dices tu *colonia* y *calle*, porfa? 🙂");
      return;
    }

    const hint = await extractColoniaHint(inbound.text);
    const match = await findColoniaMatch(hint.colonia_norm_guess || inbound.text);
    if (!match.found) {
      await send(
        "No pude identificar bien la colonia 😅\n" +
          "¿Me la puedes repetir con más detalle? (ej: Centro / Los Fresnos / etc.)"
      );
      return;
    }

    const nextData = {
      ...data,
      colonia_input: inbound.text,
      colonia: match.match.colonia,
      cobertura: match.match.cobertura,
      zona: match.match.zona || null
    };

    if (String(match.match.cobertura || "").toUpperCase() === "NO") {
      await updateSession({ step: 99, data: nextData });
      await send(
        `Gracias. Por ahora *no tenemos cobertura* en "${match.match.colonia}".\n` +
          "Si gustas, dime tu *nombre* y un *teléfono de contacto* y te avisamos cuando llegue 🙏"
      );
      return;
    }

    await updateSession({ step: 2, data: nextData });
    await send("¡Excelente! ✅\n\n2) ¿Cuál es tu *nombre completo*?");
    return;
  }

  if (step === 2) {
    if (!hasMinLen(inbound.text, 3)) {
      await send("¿Cuál es tu *nombre completo*? 🙂");
      return;
    }
    await updateSession({ step: 3, data: { ...data, nombre: inbound.text.trim() } });
    await send("3) ¿Qué *teléfono* dejamos de contacto? (10 dígitos o escribe *mismo*)");
    return;
  }

  if (step === 3) {
    const parsed = await parsePhoneE164(inbound.text, session.phone_e164);
const tel = parsed.phone_e164;

    if (t.includes("mismo")) {
      tel = session.phone_e164;
    } else if (looksLikePhone10MX(inbound.text)) {
      tel = normalizeMX10ToE164(inbound.text);
    }

    if (!tel) {
      await send("Ponme un teléfono de *10 dígitos* o escribe *mismo* 🙂");
      return;
    }

    await updateSession({ step: 4, data: { ...data, telefono_contacto: tel } });
    await send("4) Envíame foto de tu *INE (frente)* 📸");
    return;
  }

  if (step === 4) {
    if (!hasMediaUrls(inbound.media)) {
      await send("Necesito la *foto del frente* de la INE 📸 (envíala como imagen, porfa)");
      return;
    }

    const url = inbound.media.urls[0];
    await updateSession({ step: 5, data: { ...data, ine_frente_url: url } });
    await send("5) Ahora envíame la foto de tu *INE (atrás)* 📸");
    return;
  }

  if (step === 5) {
    if (!hasMediaUrls(inbound.media)) {
      await send("Necesito la *foto de atrás* de la INE 📸 (envíala como imagen, porfa)");
      return;
    }

    const url = inbound.media.urls[0];
    const finalData = { ...data, ine_reverso_url: url };

    // Crear contrato
    const c = await createContract({
      phoneE164: session.phone_e164,
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
      `Listo ✅ Ya quedó tu solicitud.\nFolio: *${c.folio}*\n\n` +
        "En breve te contactamos para confirmar instalación. 🙌"
    );
    return;
  }

  // Paso 99 (sin cobertura): capturar nombre+tel y cerrar
  if (step === 99) {
    if (!hasMinLen(inbound.text, 3)) {
      await send("Dime tu *nombre* y un *teléfono* para avisarte cuando haya cobertura 🙂");
      return;
    }
    await closeSession(session.session_id);
    await send("¡Gracias! ✅ Quedó registrado. En cuanto haya cobertura te avisamos 🙏");
    return;
  }

  // fallback
  await closeSession(session.session_id);
  await send("Listo ✅ Si necesitas algo más, escríbeme.");
}

module.exports = { intro, handle };