// src/handlers/flows/falla.js
const { hasMinLen } = require("../../utils/validators");
const { createReport } = require("../../services/reportsService");
const { notifyAdmin } = require("../../services/notifyService");

function intro() {
  return (
    "Claro, te apoyo con la falla ✅\n\n" +
    "Tu servicio está:\n" +
    "A) *Sin internet*\n" +
    "B) *Lento / intermitente*\n\n" +
    "Responde *A* o *B*."
  );
}

function norm(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ");
}

function isYes(t) {
  return /^(si|sí|s|ok|va|listo|correcto|afirmativo)$/i.test(norm(t));
}
function isNo(t) {
  return /^(no|n|nel|negativo)$/i.test(norm(t));
}

function pickAB(t) {
  const x = norm(t);
  if (x === "a" || /sin internet|no tengo internet|no hay internet/.test(x)) return "A";
  if (x === "b" || /lento|intermit|se corta|se va/.test(x)) return "B";
  return null;
}

function pickLights(t) {
  const x = norm(t);
  if (/verde|verdes/.test(x)) return "VERDE";
  if (/naranja|naranjas|rojo|rojos/.test(x)) return "NARANJA";
  return null;
}

function buildFolioMsg(folio) {
  return (
    `✅ *Reporte generado*\n` +
    `Folio: *${folio}*\n\n` +
    `Estamos trabajando para restablecer tu servicio en un lapso de *24 a 48 hrs*.\n` +
    `Si te piden el folio, compártelo por aquí.`
  );
}

async function handle({ session, inbound, send, sendImage, updateSession, closeSession }) {
  const step = Number(session.step || 1);
  const data = session.data || {};
  const txtRaw = String(inbound.text || "").trim();

  const phoneE164 = session.phone_e164 || inbound.phoneE164 || null;
  const DIAGRAM_URL = process.env.FALLA_DIAGRAM_URL || "";

  // STEP 1: tipo A/B
  if (step === 1) {
    const ab = pickAB(txtRaw);
    if (!ab) {
      await send(intro());
      return;
    }

    const next = { ...data, tipo: ab === "A" ? "SIN_INTERNET" : "LENTO_INTERMITENTE" };
    await updateSession({ step: 2, data: next });

    // ✅ manda diagrama una sola vez (si hay URL y sendImage)
    if (!next.diagram_sent && DIAGRAM_URL && typeof sendImage === "function") {
      try {
        await sendImage(
          DIAGRAM_URL,
          "📌 *Guía rápida de conexiones*\nRevisa el diagrama para confirmar que todo esté conectado."
        );
        next.diagram_sent = true;
        await updateSession({ step: 2, data: next });
      } catch {
        // si falla enviar imagen, no rompas el flujo
      }
    }

    await send("¿Los focos del módem/router se ven *verdes* o *naranjas/rojos*? (Responde: verdes / naranjas)");
    return;
  }

  // STEP 2: luces
  if (step === 2) {
    const lights = pickLights(txtRaw);
    if (!lights) {
      await send("Para ubicarlo: ¿se ven *verdes* o *naranjas/rojos*? (verdes / naranjas)");
      return;
    }

    // Si luces naranjas/rojas -> cables
    if (lights === "NARANJA") {
      await updateSession({ step: 3, data: { ...data, lights } });
      await send(
        "Eso normalmente indica un cable flojo o mal conectado.\n" +
        "¿Ya desconectaste y reconectaste *cable por cable* hasta escuchar el “click”? (sí/no)"
      );
      return;
    }

    // luces verdes -> power-cycle directo
    await updateSession({ step: 4, data: { ...data, lights } });
    await send(
      "Perfecto.\n" +
      "Ahora desconecta de la luz *módem y router* por *3 minutos* ⏱️\n" +
      "Luego conéctalos y espera *2 minutos*.\n\n" +
      "¿Se restableció el internet? (sí/no)"
    );
    return;
  }

  // STEP 3: confirmación cables
  if (step === 3) {
    if (isNo(txtRaw)) {
      await send("Hazlo por favor y cuando termines responde *listo*.");
      return;
    }
    if (!isYes(txtRaw) && norm(txtRaw) !== "listo") {
      await send("Responde *sí* (ya lo hice) o *no* (aún no).");
      return;
    }

    await updateSession({ step: 4, data: { ...data, cables_checked: true } });
    await send(
      "Gracias.\n" +
      "Ahora desconecta de la luz *módem y router* por *3 minutos* ⏱️\n" +
      "Luego conéctalos y espera *2 minutos*.\n\n" +
      "¿Se restableció el internet? (sí/no)"
    );
    return;
  }

  // STEP 4: power-cycle resultado
  if (step === 4) {
    if (isYes(txtRaw)) {
      await closeSession();
      await send("Perfecto ✅ Si vuelve a fallar, escribe *falla* y te ayudo.");
      return;
    }
    if (!isNo(txtRaw)) {
      await send("¿Se restableció? Responde *sí* o *no*.");
      return;
    }

    await updateSession({ step: 5, data: { ...data, power_cycle_done: true } });
    await send("¿Aparece el nombre de tu red WiFi en el celular/computadora? (sí/no)");
    return;
  }

  // STEP 5: SSID visible
  if (step === 5) {
    if (isYes(txtRaw)) {
      await updateSession({ step: 7, data: { ...data, ssid_visible: true } });
      await send("Entendido. Para levantar el reporte: ¿A nombre de quién está el servicio?");
      return;
    }
    if (!isNo(txtRaw)) {
      await send("Responde *sí* o *no* 🙂");
      return;
    }

    await updateSession({ step: 6, data: { ...data, ssid_visible: false } });
    await send(
      "Revisa la *etiqueta detrás del módem*: ahí viene el nombre de la red (SSID) y la contraseña.\n" +
      "¿Ya intentaste conectarte con esos datos? (sí/no)"
    );
    return;
  }

  // STEP 6: intentó etiqueta
  if (step === 6) {
    if (isNo(txtRaw)) {
      await send("Inténtalo por favor y cuando termines responde *listo*.");
      return;
    }
    if (!isYes(txtRaw) && norm(txtRaw) !== "listo") {
      await send("Responde *sí* (ya lo intenté) o *no* (aún no).");
      return;
    }

    await updateSession({ step: 7, data: { ...data, label_tried: true } });
    await send("Gracias. Para levantar el reporte: ¿A nombre de quién está el servicio?");
    return;
  }

  // STEP 7: nombre
  if (step === 7) {
    if (!hasMinLen(txtRaw, 3)) {
      await send("¿A nombre de quién está el servicio?");
      return;
    }
    await updateSession({ step: 8, data: { ...data, nombre: txtRaw } });
    await send("Describe en una frase qué pasa y desde cuándo.");
    return;
  }

  // STEP 8: descripción + crear reporte
  if (step === 8) {
    if (!hasMinLen(txtRaw, 5)) {
      await send("Dime un poquito más: ¿qué pasa exactamente y desde cuándo?");
      return;
    }

    if (!phoneE164) {
      await send("Uy 😅 no pude identificar tu número. Escribe *agente* por favor.");
      await closeSession();
      return;
    }

    const r = await createReport({
      phoneE164,
      nombre: data.nombre,
      descripcion: txtRaw,
    });

    await notifyAdmin(
      `🛠️ REPORTE DE FALLA ${r.folio}\n` +
      `Nombre: ${r.nombre}\n` +
      `Tel: ${phoneE164}\n` +
      `Tipo: ${data.tipo || "N/A"}\n` +
      `Luces: ${data.lights || "N/A"}\n` +
      `Descripción: ${r.descripcion}`
    );

    await closeSession();
    await send(buildFolioMsg(r.folio));
    return;
  }

  await closeSession();
  await send("Listo ✅ Si necesitas algo más, aquí estoy.");
}

module.exports = { intro, handle };