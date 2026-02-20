// src/services/llmService.js
const { z } = require("zod");
const { norm } = require("../utils/textUtils");

const PROVIDER = String(process.env.LLM_PROVIDER || "none").toLowerCase();
const OPENAI_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

const TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 12000);
const RETRIES = Number(process.env.LLM_RETRIES || 3);

const IntentSchema = z.object({
  intent: z.enum(["CONTRATO", "PAGO", "FALLA", "FAQ"]),
  confidence: z.number().min(0).max(1),
});

// ✅ FIX: permitir vacío/null sin romper
const ColoniaSchema = z.object({
  colonia_input: z.string().optional().default(""),
  colonia_norm_guess: z.string().optional().nullable().default(null),
  notes: z.string().optional(),
});

const PaymentParseSchema = z.object({
  mes: z.string().min(1),
  monto: z.string().min(1),
});

const PhoneParseSchema = z.object({
  phone_e164: z.string().min(8),
});

async function fetchWithTimeout(url, opts, timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...opts, signal: controller.signal });
    return resp;
  } finally {
    clearTimeout(t);
  }
}

function safeJsonParse(s) {
  try {
    return JSON.parse(String(s || "").trim());
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function openaiJson({ system, user, schema, temperature = 0 }) {
  if (PROVIDER !== "openai") throw new Error("LLM_PROVIDER must be openai");
  if (!OPENAI_KEY) throw new Error("Missing OPENAI_API_KEY");

  const url = "https://api.openai.com/v1/chat/completions";

  const messages = [
    {
      role: "system",
      content: system + "\n\nResponde SOLO con JSON válido. No agregues texto extra.",
    },
    { role: "user", content: user },
  ];

  const body = {
    model: OPENAI_MODEL,
    messages,
    temperature,
  };

  let lastErr = null;

  for (let i = 0; i < RETRIES; i++) {
    try {
      const resp = await fetchWithTimeout(
        url,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${OPENAI_KEY}`,
          },
          body: JSON.stringify(body),
        },
        TIMEOUT_MS
      );

      const raw = await resp.text();
      if (!resp.ok) throw new Error(`OpenAI HTTP ${resp.status}: ${raw}`);

      const content = JSON.parse(raw).choices?.[0]?.message?.content || "";
      const parsed = safeJsonParse(content);
      if (!parsed) throw new Error(`LLM returned non-JSON: ${content}`);

      return schema.parse(parsed);
    } catch (e) {
      lastErr = e;
      await sleep(250 * (i + 1));
    }
  }

  throw lastErr || new Error("LLM failed");
}

/** ===== Public AI functions ===== */

async function routeIntent(text) {
  const clean = String(text || "").trim();
  // si provider none: fallback simple (no crashea)
  if (PROVIDER === "none") {
    const t = norm(clean);
    if (/(contrat|instal|internet|servicio)/i.test(t)) return { intent: "CONTRATO", confidence: 0.6 };
    if (/(pago|deposit|transfer|comprobante|ticket)/i.test(t)) return { intent: "PAGO", confidence: 0.6 };
    if (/(falla|sin internet|lento|intermit)/i.test(t)) return { intent: "FALLA", confidence: 0.6 };
    return { intent: "FAQ", confidence: 0.5 };
  }

  const system =
    "Eres un clasificador de intención para un bot de ISP. Etiquetas: CONTRATO, PAGO, FALLA, FAQ.";
  const user =
    `Mensaje del cliente:\n${clean}\n\n` +
    `Devuelve JSON con { "intent": "...", "confidence": 0..1 }`;

  return await openaiJson({ system, user, schema: IntentSchema, temperature: 0 });
}

/**
 * Extrae una colonia normalizada (no valida cobertura aquí)
 * ✅ FIX: nunca revienta por vacío; retorna null si no hay colonia clara
 */
async function extractColoniaHint(text) {
  const clean = String(text || "").trim();

  if (PROVIDER === "none") {
    return { colonia_input: clean, colonia_norm_guess: null };
  }

  const system =
    "Eres un extractor de colonia/domicilio en México. Si NO puedes identificar colonia, devuelve colonia_norm_guess = null.";
  const user =
    `Texto del cliente:\n${clean}\n\n` +
    `Devuelve JSON con:\n` +
    `{ "colonia_input": "<lo que dijo>", "colonia_norm_guess": "<solo colonia normalizada o null>" }`;

  const out = await openaiJson({ system, user, schema: ColoniaSchema, temperature: 0 });

  const guess = String(out.colonia_norm_guess || "").trim();
  return {
    colonia_input: String(out.colonia_input || clean),
    colonia_norm_guess: guess.length ? guess : null,
  };
}

async function parsePaymentMesMonto(text) {
  const clean = String(text || "").trim();
  if (PROVIDER === "none") throw new Error("LLM disabled (parsePaymentMesMonto needs LLM)");

  const system =
    "Eres un extractor de mes y monto de pagos de internet. Si el monto trae coma o punto, respétalo como string.";
  const user = `Texto:\n${clean}\n\nDevuelve JSON { "mes": "...", "monto": "..." }`;

  return await openaiJson({ system, user, schema: PaymentParseSchema, temperature: 0 });
}

async function parsePhoneE164(text, fallbackE164) {
  const clean = String(text || "").trim();
  if (PROVIDER === "none") return { phone_e164: fallbackE164 };

  const system =
    "Eres un normalizador de teléfonos México. Si dice 'mismo', usa el fallback. Devuelve E164 +52XXXXXXXXXX.";
  const user =
    `Texto: ${clean}\nFallback: ${fallbackE164}\n\n` +
    `Devuelve JSON { "phone_e164": "+52..." }`;

  return await openaiJson({ system, user, schema: PhoneParseSchema, temperature: 0 });
}

/**
 * ✅ Polish seguro: si LLM falla, regresa rawReply (NUNCA rompe el bot)
 */
async function polishReply({ intent, step, rawReply, userText, profileName }) {
  const base = String(rawReply || "");
  if (!base.trim()) return base;
  if (PROVIDER !== "openai" || !OPENAI_KEY) return base;

  const system = `
Eres un asistente humano profesional de una empresa de internet (InterWIFI) en Encarnación de Díaz, Jalisco.
Tu tarea: reescribir el mensaje base para sonar natural, cálido y eficiente.
Reglas:
- NO digas que eres bot.
- NO inventes datos.
- NO cambies números, direcciones, horarios, cuentas o políticas.
- Mantén el mensaje corto.
- Máximo 1 emoji.
- Máximo 1 pregunta.
Responde SOLO JSON: { "text": "..." }
`.trim();

  const name = profileName ? `Cliente: ${profileName}\n` : "";
  const user = `
${name}INTENT=${intent || "unknown"} STEP=${step || ""}
Mensaje del cliente: ${String(userText || "")}
Mensaje base:
${base}
`.trim();

  const schema = z.object({ text: z.string().min(1) });

  try {
    const out = await openaiJson({ system, user, schema, temperature: 0.7 });
    return String(out.text || base).trim() || base;
  } catch {
    return base;
  }
}

module.exports = {
  routeIntent,
  extractColoniaHint,
  parsePaymentMesMonto,
  parsePhoneE164,
  polishReply,
};