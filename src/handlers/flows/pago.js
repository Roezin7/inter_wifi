// src/handlers/flows/pago.js
const { hasMinLen, hasMediaUrls } = require("../../utils/validators");
const { extractFirstNumber } = require("../../utils/textUtils");
const { createPayment } = require("../../services/paymentsService");
const { notifyAdmin } = require("../../services/notifyService");
const { parsePaymentMesMonto } = require("../../services/llmService");
const { storeToR2 } = require("../../services/r2UploadService");
const { pickInboundMedia } = require("../../utils/inboundMedia");
const { introPair, nextPair, confirmPair, closePair } = require("../../utils/flowCopy");

// =====================
// Copy / UX
// =====================
function intro() {
  return introPair("pago", "Para empezar, ¿a nombre de quién está el servicio?");
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
 * ✅ Registra el pago AHORA (sin esperar otro inbound).
 * - Si comprobante es .enc, storeToR2 lo desencripta usando mediaKey.
 */
async function registerPaymentNow({
  session,
  data,
  phoneE164,
  dbClient,
  notifyAdminFn = notifyAdmin,
}) {
  let comprobantePublicUrl = data.comprobante_public_url || null;
  let comprobanteMime = data.comprobante_mime || null;

  // Si tenemos comprobante_url + mediaKey, intentamos subirlo a R2
  if (!comprobantePublicUrl && data.comprobante_url && data.comprobante_media_key) {
    const uploaded = await storeToR2({
      url: data.comprobante_url,
      mediaKey: data.comprobante_media_key,
      mimetype: data.comprobante_mime || "",
      folder: "payments/receipts",
      filenamePrefix: "comprobante",
      phoneE164,
    });

    comprobantePublicUrl = uploaded?.publicUrl || null;
    comprobanteMime = uploaded?.contentType || comprobanteMime;
  }

  const p = await createPayment(
    {
      phoneE164,
      nombre: data.nombre,
      mes: data.mes,
      monto: data.monto,

      // auditoría/origen
      comprobante_url: data.comprobante_url || null,
      comprobante_media_id: data.comprobante_media_id || null,
      comprobante_mime: comprobanteMime || null,

      // ✅ la buena
      comprobante_public_url: comprobantePublicUrl || null,
    },
    dbClient
  );

  await notifyAdminFn(buildAdminPaymentMsg(p));
  return p;
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
  const txt = String(inbound.text || "").trim();
  const phoneE164 = session.phone_e164 || inbound.phoneE164;

  // STEP 1: nombre
  if (step === 1) {
    if (!hasMinLen(txt, 3)) {
      await send("Necesito el nombre del titular para continuar 😊");
      return;
    }
    await updateSession({ step: 2, data: { ...data, nombre: txt } });

    await send(
      nextPair(
        "pago:ask_month_amount",
        "¿De qué *mes* es el pago y de cuánto fue?\nPor ejemplo: *enero 500*.\n\nSi quieres, también puedes mandar primero el *comprobante*."
      )
    );
    return;
  }

  // STEP 2: mes+monto (o comprobante primero)
  if (step === 2) {
    // Si mandó comprobante primero
    if (hasMediaUrls(inbound.media)) {
      const m = pickInboundMedia(inbound.media);

      if (!m.url || !m.mediaKey) {
        await send("No pude leer el comprobante 😕 Reenvíalo como *foto o PDF*, por favor.");
        return;
      }

      // ✅ Subimos de una vez a R2, así ya guardas la URL pública
      let uploaded;
      try {
        uploaded = await storeToR2({
          url: m.url,
          mediaKey: m.mediaKey,
          mimetype: m.mimetype || "",
          folder: "payments/receipts",
          filenamePrefix: "comprobante",
          phoneE164,
        });
      } catch (e) {
        await send("Tuve un problema guardando el comprobante 😕 Reenvíalo como *foto o PDF*, por favor.");
        return;
      }

      const next = {
        ...data,
        comprobante_url: m.url, // origen (enc)
        comprobante_public_url: uploaded?.publicUrl || null, // ✅ r2
        comprobante_media_id: m.id || null,
        comprobante_media_key: m.mediaKey || null,
        comprobante_mime: uploaded?.contentType || m.mimetype || null,
      };

      await updateSession({ step: 22, data: next });
      await send(nextPair("pago:receipt_first", "Ya tengo el comprobante.\nAhora dime de qué *mes* fue y de cuánto."));
      return;
    }

    // Si es texto (mes+monto)
    if (!hasMinLen(txt, 3)) {
      await send("Compárteme el *mes* y el *monto* del pago.");
      return;
    }

    const { mes, monto } = await safeParseMesMonto(txt);

    if (!monto) {
      await send("No alcancé a identificar el *monto*. Envíamelo junto con el mes, por favor.");
      return;
    }
    if (!mes) {
      await send("Perfecto. ¿De qué *mes* fue el pago?");
      return;
    }

    const next = { ...data, mes, monto };
    await updateSession({ step: 25, data: next });
    await send(confirmPair(`pago:confirm:${mes}:${monto}`, `*${mes}* por *$${monto}*.\n¿Correcto?`));
    return;
  }

  // STEP 22: ya tenemos comprobante, falta mes+monto
  if (step === 22) {
    if (!hasMinLen(txt, 3)) {
      await send("Compárteme el *mes* y el *monto* del pago.");
      return;
    }

    const { mes, monto } = await safeParseMesMonto(txt);

    if (!monto) {
      await send("No alcancé a identificar el *monto*. Envíamelo junto con el mes, por favor.");
      return;
    }
    if (!mes) {
      await send("Perfecto. ¿De qué *mes* fue el pago?");
      return;
    }

    const next = { ...data, mes, monto };
    await updateSession({ step: 25, data: next });
    await send(confirmPair(`pago:confirm_receipt:${mes}:${monto}`, `*${mes}* por *$${monto}*.\n¿Correcto?`));
    return;
  }

  // STEP 25: confirmación
  if (step === 25) {
    if (looksLikeYes(txt)) {
      const hasReceipt = !!(data.comprobante_public_url || data.comprobante_url);

      if (hasReceipt) {
        await send("Perfecto 😊 Estoy registrando tu pago.");

        try {
          const p = await registerPaymentNow({
            session,
            data,
            phoneE164,
            dbClient,
            notifyAdminFn: notifyAdminFn || notifyAdmin,
          });
          await closeSession(session.session_id);
          await send(closePair(`pago:done:${p.folio}`, `Tu pago quedó registrado.\nFolio: *${p.folio}*`));
          return;
        } catch (e) {
          await send(
            "Tuve un problema al registrar el pago 😕\n" +
              "Reenvíame el comprobante y el dato del mes con el monto, por favor."
          );
          await updateSession({ step: 2, data: { ...data } });
          return;
        }
      }

      await updateSession({ step: 3, data });
      await send(nextPair("pago:ask_receipt", "Envíame el *comprobante* en foto o PDF."));
      return;
    }

    if (looksLikeNo(txt)) {
      const backStep = data.comprobante_url || data.comprobante_public_url ? 22 : 2;
      await updateSession({ step: backStep, data: { ...data, mes: null, monto: null } });
      await send("De acuerdo. Corrígeme, por favor. ¿De qué mes fue y cuánto pagaste?");
      return;
    }

    await send("Por favor, confírmame con *sí* o *no* 😊");
    return;
  }

  // STEP 3: esperar comprobante
  if (step === 3) {
    if (!hasMediaUrls(inbound.media)) {
      await send("Necesito el *comprobante* en foto o PDF 😊");
      return;
    }

    const m = pickInboundMedia(inbound.media);
    if (!m.url || !m.mediaKey) {
      await send("No pude leer el comprobante 😕 Reenvíalo como *foto o PDF*, por favor.");
      return;
    }

    // ✅ Subimos a R2 aquí también
    let uploaded;
    try {
      uploaded = await storeToR2({
        url: m.url,
        mediaKey: m.mediaKey,
        mimetype: m.mimetype || "",
        folder: "payments/receipts",
        filenamePrefix: "comprobante",
        phoneE164,
      });
    } catch (e) {
      await send("Tuve un problema guardando el comprobante 😕 Reenvíalo como *foto o PDF*, por favor.");
      return;
    }

    const next = {
      ...data,
      comprobante_url: m.url,
      comprobante_public_url: uploaded?.publicUrl || null,
      comprobante_media_id: m.id || null,
      comprobante_media_key: m.mediaKey || null,
      comprobante_mime: uploaded?.contentType || m.mimetype || null,
    };

    await send("Perfecto 😊 Estoy registrando tu pago.");

    try {
      const p = await registerPaymentNow({
        session,
        data: next,
        phoneE164,
        dbClient,
        notifyAdminFn: notifyAdminFn || notifyAdmin,
      });
      await closeSession(session.session_id);
      await send(closePair(`pago:done_receipt:${p.folio}`, `Tu pago quedó registrado.\nFolio: *${p.folio}*`));
      return;
    } catch (e) {
      await send(
        "Tuve un problema al registrar el pago 😕\n" +
          "Reenvíame el comprobante y vuelve a decirme el mes con el monto, por favor."
      );
      await updateSession({ step: 2, data: { ...data, ...next } });
      return;
    }
  }

  await closeSession(session.session_id);
  await send(closePair("pago:fallback", "Si necesitas algo más, aquí te apoyo 😊"));
}

module.exports = { intro, handle };
