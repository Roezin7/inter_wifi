const { z } = require("zod");
const { norm } = require("../../utils/textUtils");

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

const PROVIDER = String(process.env.LLM_PROVIDER || "none").toLowerCase();
const OPENAI_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

const TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 12000);
const RETRIES = Number(process.env.LLM_RETRIES || 3);
const STRICT = String(process.env.LLM_STRICT || "true").toLowerCase() === "true";

const IntentSchema = z.object({
  intent: z.enum(["CONTRATO", "PAGO", "FALLA", "FAQ"]),
  confidence: z.number().min(0).max(1)
});

const ColoniaSchema = z.object({
  colonia_input: z.string().min(1),
  colonia_norm_guess: z.string().min(1),
  notes: z.string().optional()
});

const PaymentParseSchema = z.object({
  mes: z.string().min(1),
  monto: z.string().min(1)
});

const PhoneParseSchema = z.object({
  phone_e164: z.string().min(8)
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

async function openaiJson({ system, user, schema }) {
  if (PROVIDER !== "openai") throw new Error("LLM_PROVIDER must be openai");
  if (!OPENAI_KEY) throw new Error("Missing OPENAI_API_KEY");

  const url = "https://api.openai.com/v1/chat/completions";

  // Pedimos JSON en texto y lo validamos nosotros (robusto y simple)
  const messages = [
    {
      role: "system",
      content:
        system +
        "\n\nResponde SOLO con JSON válido. No agregues texto extra."
    },
    { role: "user", content: user }
  ];

  const body = {
    model: OPENAI_MODEL,
    messages,
    temperature: 0
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
            Authorization: `Bearer ${OPENAI_KEY}`
          },
          body: JSON.stringify(body)
        },
        TIMEOUT_MS
      );

      const raw = await resp.text();

      if (!resp.ok) throw new Error(`OpenAI HTTP ${resp.status}: ${raw}`);

      let json;
      try {
        json = JSON.parse(raw)?.choices?.[0]?.message?.content;
      } catch {
        // a veces raw es json; content está dentro
      }

      const content = JSON.parse(raw).choices?.[0]?.message?.content || "";
      const parsed = safeJsonParse(content);
      if (!parsed) throw new Error(`LLM returned non-JSON: ${content}`);

      const validated = schema.parse(parsed);
      return validated;
    } catch (e) {
      lastErr = e;
      // backoff
      await sleep(250 * (i + 1));
    }
  }

  throw lastErr || new Error("LLM failed");
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

/** ===== Public AI functions ===== */

async function routeIntent(text) {
  const clean = String(text || "").trim();
  const system =
    "Eres un clasificador de intención para un bot de ISP. Etiquetas: CONTRATO, PAGO, FALLA, FAQ.";
  const user =
    `Mensaje del cliente:\n${clean}\n\n` +
    `Devuelve JSON con { "intent": "...", "confidence": 0..1 }`;

  const out = await openaiJson({ system, user, schema: IntentSchema });
  return out;
}

/**
 * Extrae una colonia normalizada (no valida cobertura aquí; eso lo hace DB match)
 * Sirve para mejorar el fuzzy (ej: "fracc los fresnos" -> "los fresnos")
 */
async function extractColoniaHint(text) {
  const clean = String(text || "").trim();
  const system =
    "Eres un extractor de colonia/domicilio en México. Normaliza sin acentos, sin abreviaturas raras.";
  const user =
    `Texto del cliente:\n${clean}\n\n` +
    `Devuelve JSON con:\n` +
    `{ "colonia_input": "<lo que dijo>", "colonia_norm_guess": "<solo colonia normalizada>" }`;

  const out = await openaiJson({ system, user, schema: ColoniaSchema });
  return out;
}

async function parsePaymentMesMonto(text) {
  const clean = String(text || "").trim();
  const system =
    "Eres un extractor de mes y monto de pagos de internet. Si el monto trae coma o punto, respétalo como string.";
  const user =
    `Texto:\n${clean}\n\nDevuelve JSON { "mes": "...", "monto": "..." }`;
  const out = await openaiJson({ system, user, schema: PaymentParseSchema });
  return out;
}

async function parsePhoneE164(text, fallbackE164) {
  const clean = String(text || "").trim();
  const system =
    "Eres un normalizador de teléfonos México. Si dice 'mismo', usa el fallback. Devuelve E164 +52XXXXXXXXXX.";
  const user =
    `Texto: ${clean}\nFallback: ${fallbackE164}\n\n` +
    `Devuelve JSON { "phone_e164": "+52..." }`;
  const out = await openaiJson({ system, user, schema: PhoneParseSchema });
  return out;
}

module.exports = {
  routeIntent,
  extractColoniaHint,
  parsePaymentMesMonto,
  parsePhoneE164
};