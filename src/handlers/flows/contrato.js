// src/handlers/flows/contrato.js
const {
  hasMinLen,
  looksLikePhone10MX,
  normalizeMX10ToE164,
  hasMediaUrls
} = require("../../utils/validators");

const { resolveColonia } = require("../../services/coverageService");
const { createContract } = require("../../services/contractsService");
const { notifyAdmin } = require("../../services/notifyService");
const { parsePhoneE164 } = require("../../services/llmService"); // solo para teléfono

let templates, pick;
try {
  ({ templates, pick } = require("../../utils/replies"));
} catch {}

function intro(seed) {
  if (templates && pick) return pick(templates.contrato_intro, seed)();
  return (
    "Va, te ayudo con la contratación 🙌\n" +
    "Para revisar cobertura, mándame tu *colonia*.\n" +
    "Si ya tienes: *colonia, calle y número* mejor (Ej: “Centro, Hidalgo 311”)."
  );
}

function askColonia() {
  return "¿En qué *colonia* estás? (Ej: Centro / Las Américas)";
}

function askCalleNumero() {
  return "Perfecto ✅ Ahora pásame tu *calle y número* (Ej: “Hidalgo 311”).";
}

function askPickColonia(cands) {
  const lines = cands
    .slice(0, 5)
    .map((c, i) => `${i + 1}) ${c.colonia}`)
    .join("\n");
  return (
    "¿Cuál de estas colonias es?\n" +
    lines +
    "\n\nRespóndeme con el número (1, 2, 3...)"
  );
}

function trySplitAddress(text) {
  const t = String(text || "").trim();

  // Caso: "Centro, Hidalgo 311"
  if (t.includes(",")) {
    const [a, b] = t.split(",").map((x) => x.trim());
    const coloniaPart = a || "";
    const rest = b || "";
    const hasNum = /\d/.test(rest);
    return {
      coloniaPart,
      calleNumero: hasNum ? rest : ""
    };
  }

  // Si no hay coma, no adivinamos colonia aquí
  return { coloniaPart: "", calleNumero: "" };
}

async function handle({ session, inbound, send, updateSession, closeSession }) {
  const step = Number(session.step || 1);
  const data = session.data || {};
  const phoneE164 = session.phone_e164 || inbound.phoneE164;
  const txt = String(inbound.text || "").trim();

  // STEP 1: colonia o colonia+calle
  if (step === 1) {
    if (!hasMinLen(txt, 2)) {
      await send(intro(phoneE164));
      return;
    }

    // Intento split si viene con coma
    const { coloniaPart, calleNumero } = trySplitAddress(txt);

    // 1A) Si viene colonia explícita (por coma)
    if (coloniaPart) {
      const r = await resolveColonia(coloniaPart);

      if (!r.ok) {
        await send(
          "No ubiqué esa colonia 😅\n" +
          "¿Me la escribes tal cual aparece? (Ej: Las Américas)"
        );
        return;
      }

      if (r.autoAccept) {
        const next = {
          ...data,
          colonia_input: coloniaPart,
          colonia: r.best.colonia,
          cobertura: r.best.cobertura,
          zona: r.best.zona,
          colonia_confirmed: true
        };

        // Si además ya venía calle+número en el mismo mensaje
        if (calleNumero) {
          await updateSession({ step: 2, data: { ...next, calle_numero: calleNumero } });
          await send("Excelente ✅ ¿Cuál es tu *nombre completo*?");
          return;
        }

        await updateSession({ step: 11, data: next });
        await send(`Perfecto ✅ Estás en *${next.colonia}*.\n${askCalleNumero()}`);
        return;
      }

      // no autoAccept => shortlist
      await updateSession({
        step: 12,
        data: {
          ...data,
          colonia_input: coloniaPart,
          colonia_candidates: r.candidates.slice(0, 5)
        }
      });
      await send(askPickColonia(r.candidates));
      return;
    }

    // 1B) Si mandó “Las Américas” o “Centro” (sin coma)
    const r = await resolveColonia(txt);

    if (!r.ok) {
      await send("¿En qué *colonia* estás? (Ej: Centro / Las Américas)");
      return;
    }

    if (r.autoAccept) {
      const next = {
        ...data,
        colonia_input: txt,
        colonia: r.best.colonia,
        cobertura: r.best.cobertura,
        zona: r.best.zona,
        colonia_confirmed: true
      };
      await updateSession({ step: 11, data: next });
      await send(`Perfecto ✅ Estás en *${next.colonia}*.\n${askCalleNumero()}`);
      return;
    }

    // shortlist
    await updateSession({
      step: 12,
      data: { ...data, colonia_input: txt, colonia_candidates: r.candidates.slice(0, 5) }
    });
    await send(askPickColonia(r.candidates));
    return;
  }

  // STEP 12: elegir colonia por número
  if (step === 12) {
    const n = Number(String(txt).trim());
    const cands = Array.isArray(data.colonia_candidates) ? data.colonia_candidates : [];

    if (!Number.isFinite(n) || n < 1 || n > cands.length) {
      await send("Respóndeme con el número 🙂 (1, 2, 3...)");
      return;
    }

    const picked = cands[n - 1];

    const next = {
      ...data,
      colonia: picked.colonia,
      cobertura: picked.cobertura,
      zona: picked.zona || null,
      colonia_confirmed: true,
      colonia_candidates: [] // limpia
    };

    await updateSession({ step: 11, data: next });
    await send(`Listo ✅ Colonia *${next.colonia}*.\n${askCalleNumero()}`);
    return;
  }

  // STEP 11: ya hay colonia, pedir calle + número
  if (step === 11) {
    if (!/\d/.test(txt) || txt.length < 5) {
      await send("¿Me lo mandas como *calle y número*? Ej: “Hidalgo 311” 🙂");
      return;
    }

    const nextData = { ...data, calle_numero: txt };

    if (String(nextData.cobertura || "").toUpperCase() === "NO") {
      await updateSession({ step: 99, data: nextData });
      await send(
        `Gracias. Por ahora *no tenemos cobertura* en *${nextData.colonia}*.\n` +
        "Si gustas, dime tu *nombre* y un *teléfono de contacto* y te avisamos cuando llegue 🙏"
      );
      return;
    }

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
    const raw = String(inbound.text || "").trim();
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