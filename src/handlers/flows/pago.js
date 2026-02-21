// src/handlers/flows/pago.js
const { hasMinLen, hasMediaUrls } = require("../../utils/validators");
const { extractFirstNumber } = require("../../utils/textUtils");
const { createPayment } = require("../../services/paymentsService");
const { notifyAdmin } = require("../../services/notifyService");
const { parsePaymentMesMonto } = require("../../services/llmService");
const { resolveAndStoreMedia } = require("../../services/mediaService");

// =====================
// Copy / UX
// =====================
function intro() {
  return "Perfecto ✅ ¿A nombre de quién está el servicio?";
}

function looksLikeYes(t) {
  return /(si|sí|correcto|ok|va|confirmo|exacto|claro|asi es|así es)/i.test(
    String(t || "").trim()
  );
}
function looksLikeNo(t) {
  return /(no|nel|incorrecto|equivocado|error|nope)/i.test(String(t || "").trim());
}

function normalizeMes(mesRaw) {
  const s = String(mesRaw || "").trim().toLowerCase();

  const map = [
    ["enero", ["ene", "enero"]],
    ["febrero", ["feb", "febrero"]],
    ["marzo", ["mar", "marzo"]],
    ["abril", ["abr", "abril"]],
    ["mayo", ["may", "mayo"]],
    ["junio", ["jun", "junio"]],
    ["julio", ["jul", "julio"]],
    ["agosto", ["ago", "agosto"]],
    ["septiembre", ["sep", "sept", "septiembre", "setiembre"]],
    ["octubre", ["oct", "octubre"]],
    ["noviembre", ["nov", "noviembre"]],
    ["diciembre", ["dic", "diciembre"]],
  ];

  for (const [canon, variants] of map) {
    if (variants.some((v) => s.includes(v))) return canon;
  }
  return "";
}

function normalizeMonto(montoRaw) {
  const s = String(montoRaw || "").trim();
  if (!s) return "";
  const n = extractFirstNumber(s);
  if (!n) return "";
  return String(n);
}

async function safeParseMesMonto(text) {
  const clean = String(text || "").trim();
  if (!clean) return { mes: "", monto: "" };

  // 1) intenta LLM
  try {
    const parsed = await parsePaymentMesMonto(clean);
    const mes = normalizeMes(parsed?.mes);
    const monto = normalizeMonto(parsed?.monto);
    if (mes && monto) return { mes, monto };
  } catch {}

  // 2) fallback local
  const mes = normalizeMes(clean);
  const monto = normalizeMonto(clean);
  return { mes, monto };
}

function pickMedia(inboundMedia) {
  const urls = inboundMedia?.urls || [];
  const items = inboundMedia?.items || [];
  const first = items?.[0] || null;

  return {
    url: first?.url || urls?.[0] || null,
    id: first?.id || inboundMedia?.id || null,
    mimetype: first?.mimetype || inboundMedia?.mimetype || null,
  };
}

function buildAdminPaymentMsg(p) {
  const lines = [
    `💵 *PAGO REGISTRADO* ${p.folio}`,
    ``,
    `*Nombre:* ${p.nombre || "N/A"}`,
    `*Mes:* ${p.mes || "N/A"}`,
    `*Monto:* $${p.monto || "N/A"}`,
    `*Tel:* ${p.phone_e164 || "N/A"}`,
    ``,
    `*Comprobante:*`,
    `${p.comprobante_public_url || p.comprobante_url || "N/A"}`,
  ];
  return lines.join("\n");
}

/**
 * Registra el pago AHORA (sin esperar otro inbound).
 * Esto evita que se quede colgado en step 4.
 */
async function registerPaymentNow({ session, data, phoneE164 }) {
  // intenta convertir .enc a public url (si tienes storage habilitado)
  const stored = await resolveAndStoreMedia({
    providerUrl: data.comprobante_url,
    mediaId: data.comprobante_media_id,
    mime: data.comprobante_mime,
    phoneE164,
    kind: "payment_receipt",
  });

  const p = await createPayment({
    phoneE164,
    nombre: data.nombre,
    mes: data.mes,
    monto: data.monto,
    comprobante_url: data.comprobante_url || null,
    comprobante_media_id: data.comprobante_media_id || null,
    comprobante_mime: data.comprobante_mime || null,
    comprobante_public_url: stored?.publicUrl || null,
  });

  await notifyAdmin(buildAdminPaymentMsg(p));

  return p;
}

// =====================
// Flow
// =====================
async function handle({ session, inbound, send, updateSession, closeSession }) {
  const step = Number(session.step || 1);
  const data = session.data || {};
  const txt = String(inbound.text || "").trim();
  const phoneE164 = session.phone_e164 || inbound.phoneE164;

  // STEP 1: nombre
  if (step === 1) {
    if (!hasMinLen(txt, 3)) {
      await send("¿A nombre de quién está el servicio?");
      return;
    }
    await updateSession({ step: 2, data: { ...data, nombre: txt } });

    await send(
      "Gracias. ¿De qué *mes* es el pago y de cuánto fue?\n" +
        "Ejemplo: *Enero 500*\n\n" +
        "Tip: también puedes mandar el *comprobante* primero 📎"
    );
    return;
  }

  // STEP 2: mes+monto (o comprobante primero)
  if (step === 2) {
    // Si mandó comprobante primero
    if (hasMediaUrls(inbound.media)) {
      const m = pickMedia(inbound.media);
      if (!m.url && !m.id) {
        await send("No pude leer el comprobante 😅 ¿Me lo reenvías como *foto o PDF*?");
        return;
      }

      const next = {
        ...data,
        comprobante_url: m.url || null,
        comprobante_media_id: m.id || null,
        comprobante_mime: m.mimetype || null,
      };

      await updateSession({ step: 22, data: next });
      await send("Listo ✅ Ahora dime: ¿de qué *mes* fue y de cuánto? (ej: *Enero 500*)");
      return;
    }

    // Si es texto (mes+monto)
    if (!hasMinLen(txt, 3)) {
      await send("Ponme el *mes* y el *monto* (ej: *Enero 500*).");
      return;
    }

    const { mes, monto } = await safeParseMesMonto(txt);

    if (!monto) {
      await send("No alcancé a ver el *monto* 😅 Ponlo así: *Enero 500*.");
      return;
    }
    if (!mes) {
      await send("Perfecto, ¿de qué *mes* fue el pago? (ej: *Enero*)");
      return;
    }

    const next = { ...data, mes, monto };
    await updateSession({ step: 25, data: next });
    await send(`Solo para confirmar: *${mes}* por *$${monto}*. ¿Correcto?`);
    return;
  }

  // STEP 22: ya tenemos comprobante, falta mes+monto
  if (step === 22) {
    if (!hasMinLen(txt, 3)) {
      await send("Dime el *mes* y el *monto* (ej: *Enero 500*).");
      return;
    }

    const { mes, monto } = await safeParseMesMonto(txt);

    if (!monto) {
      await send("No alcancé a ver el *monto* 😅 Ponlo así: *Enero 500*.");
      return;
    }
    if (!mes) {
      await send("Perfecto, ¿de qué *mes* fue el pago? (ej: *Enero*)");
      return;
    }

    const next = { ...data, mes, monto };
    await updateSession({ step: 25, data: next });
    await send(`Solo para confirmar: *${mes}* por *$${monto}*. ¿Correcto?`);
    return;
  }

  // STEP 25: confirmación
  if (step === 25) {
    if (looksLikeYes(txt)) {
      // ✅ Si ya existe comprobante, registramos AHORA mismo (no esperar otro inbound)
      const hasReceipt = !!(data.comprobante_url || data.comprobante_media_id);

      if (hasReceipt) {
        await send("Perfecto ✅ Estoy registrando tu pago…");

        try {
          const p = await registerPaymentNow({ session, data, phoneE164 });
          await closeSession(session.session_id);
          await send(`¡Gracias! ✅ Pago registrado.\nFolio: *${p.folio}*`);
          return;
        } catch (e) {
          // No cierres sesión si falló, para que pueda reintentar
          await send(
            "Uy 😅 tuve un problema registrando el pago.\n" +
              "¿Me reenvías el comprobante y el mes/monto? (ej: *Enero 500*)"
          );
          await updateSession({ step: 2, data: { ...data } });
          return;
        }
      }

      // Si aún no hay comprobante, lo pedimos
      await updateSession({ step: 3, data });
      await send("Listo ✅ Envíame el *comprobante* (foto o PDF) 📎");
      return;
    }

    if (looksLikeNo(txt)) {
      // si ya tenemos comprobante, regresamos a 22, si no a 2
      const backStep = data.comprobante_url || data.comprobante_media_id ? 22 : 2;
      await updateSession({ step: backStep, data: { ...data, mes: null, monto: null } });
      await send("Va 🙂 corrígeme por favor. ¿De qué mes fue y cuánto pagaste? (ej: *Enero 500*)");
      return;
    }

    await send("¿Me confirmas con un *sí* o *no*? 🙂");
    return;
  }

  // STEP 3: esperar comprobante
  if (step === 3) {
    if (!hasMediaUrls(inbound.media)) {
      await send("Necesito el *comprobante* (foto/PDF) 📎");
      return;
    }

    const m = pickMedia(inbound.media);
    if (!m.url && !m.id) {
      await send("No pude leer el comprobante 😅 ¿Me lo reenvías como *foto o PDF*?");
      return;
    }

    const next = {
      ...data,
      comprobante_url: m.url || null,
      comprobante_media_id: m.id || null,
      comprobante_mime: m.mimetype || null,
    };

    await send("Perfecto ✅ Estoy registrando tu pago…");

    try {
      const p = await registerPaymentNow({ session, data: next, phoneE164 });
      await closeSession(session.session_id);
      await send(`¡Gracias! ✅ Pago registrado.\nFolio: *${p.folio}*`);
      return;
    } catch (e) {
      await send(
        "Uy 😅 tuve un problema registrando el pago.\n" +
          "¿Me lo reenvías como *foto o PDF* y dime *mes+monto*? (ej: *Enero 500*)"
      );
      await updateSession({ step: 2, data: { ...data, ...next } });
      return;
    }
  }

  await closeSession(session.session_id);
  await send("Listo ✅");
}

module.exports = { intro, handle };