// src/handlers/flows/pago.js
const { hasMinLen, hasMediaUrls } = require("../../utils/validators");
const { extractFirstNumber } = require("../../utils/textUtils");
const { createPayment } = require("../../services/paymentsService");
const { notifyAdmin } = require("../../services/notifyService");
const { parsePaymentMesMonto } = require("../../services/llmService");

function intro() {
  return "Perfecto ✅ ¿A nombre de quién está el servicio?";
}

function looksLikeYes(t) {
  return /(si|sí|correcto|ok|va|confirmo|exacto)/i.test(String(t || "").trim());
}
function looksLikeNo(t) {
  return /(no|nel|incorrecto|equivocado)/i.test(String(t || "").trim());
}

async function safeParseMesMonto(text) {
  const clean = String(text || "").trim();

  // 1) intenta LLM
  try {
    const parsed = await parsePaymentMesMonto(clean);
    const mes = String(parsed?.mes || "").trim();
    const monto = String(parsed?.monto || "").trim();
    if (mes && monto) return { mes, monto };
  } catch {
    // ignore
  }

  // 2) fallback: monto por primer número
  const n = extractFirstNumber(clean);
  const monto = n ? String(n) : "";

  // 3) mes: intenta detectar mes por texto (simple)
  const lower = clean.toLowerCase();
  const meses = [
    "enero","febrero","marzo","abril","mayo","junio",
    "julio","agosto","septiembre","octubre","noviembre","diciembre"
  ];
  const mes = meses.find(m => lower.includes(m)) || "";

  return { mes, monto };
}

async function handle({ session, inbound, send, updateSession, closeSession }) {
  const step = Number(session.step || 1);
  const data = session.data || {};
  const txt = String(inbound.text || "").trim();

  if (step === 1) {
    if (!hasMinLen(txt, 3)) {
      await send("¿A nombre de quién está el servicio?");
      return;
    }
    await updateSession({ step: 2, data: { ...data, nombre: txt } });
    await send("Gracias. ¿De qué *mes* es el pago y de cuánto fue? (ej: “Enero 500”)");
    return;
  }

  if (step === 2) {
    if (!hasMinLen(txt, 3)) {
      await send("Ponme el *mes* y el *monto* (ej: “Enero 500”).");
      return;
    }

    const { mes, monto } = await safeParseMesMonto(txt);

    if (!monto) {
      await send("No alcancé a ver el *monto* 😅 Ponlo así: “Enero 500”.");
      return;
    }
    if (!mes) {
      await send("Perfecto, ¿de qué *mes* fue el pago? (ej: Enero)");
      return;
    }

    const next = { ...data, mes, monto };
    await updateSession({ step: 25, data: next });

    await send(`Solo para confirmar: *${mes}* por *$${monto}*. ¿Correcto?`);
    return;
  }

  // confirmación
  if (step === 25) {
    if (looksLikeYes(txt)) {
      await updateSession({ step: 3, data });
      await send("Listo ✅ Envíame el *comprobante* (foto o PDF) 📎");
      return;
    }
    if (looksLikeNo(txt)) {
      await updateSession({ step: 2, data: { ...data, mes: null, monto: null } });
      await send("Va, corrígeme por favor 🙂 ¿De qué mes fue y cuánto pagaste? (ej: “Enero 500”)");
      return;
    }
    await send("¿Me confirmas con un *sí* o *no*? 🙂");
    return;
  }

  if (step === 3) {
    if (!hasMediaUrls(inbound.media)) {
      await send("Necesito el *comprobante* (foto/PDF) 📎");
      return;
    }

    const url = inbound.media.urls[0];
    const finalData = { ...data, comprobante_url: url };

    const p = await createPayment({
      phoneE164: session.phone_e164,
      nombre: finalData.nombre,
      mes: finalData.mes,
      monto: finalData.monto,
      comprobante_url: finalData.comprobante_url
    });

    await notifyAdmin(
      `💵 PAGO REGISTRADO ${p.folio}\n` +
      `Nombre: ${p.nombre}\n` +
      `Mes: ${p.mes}\n` +
      `Monto: ${p.monto}\n` +
      `Comprobante: ${p.comprobante_url}`
    );

    await closeSession(session.session_id);
    await send(`¡Gracias! ✅ Pago registrado.\nFolio: *${p.folio}*`);
    return;
  }

  await closeSession(session.session_id);
  await send("Listo ✅");
}

module.exports = { intro, handle };