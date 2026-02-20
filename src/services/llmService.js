// src/services/llmService.js
const { z } = require("zod");

const PROVIDER = String(process.env.LLM_PROVIDER || "none").toLowerCase();
const OPENAI_KEY = String(process.env.OPENAI_API_KEY || "");
const OPENAI_MODEL = String(process.env.OPENAI_MODEL || "gpt-4o-mini");

const TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 12000);
const RETRIES = Number(process.env.LLM_RETRIES || 2);

// ===== Schemas =====
const IntentSchema = z.object({
  intent: z.enum(["CONTRATO", "PAGO", "FALLA", "FAQ"]),
  confidence: z.number().min(0).max(1)
});

/**
 * colonia_norm_guess puede venir vacío.
 * Nunca debe tumbar el webhook.
 */
const ColoniaSchema = z.object({
  colonia_input: z.string().optional().default(""),
  colonia_norm_guess: z.string().optional().default(""),
  notes: z.string().optional()
});

const PaymentParseSchema = z.object({
  mes: z.string().min(1),
  monto: z.string().min(1)
});

const PhoneParseSchema = z.object({
  phone_e164: z.string().min(8)
});

// ===== Helpers =====
async function fetchWithTimeout(url, opts, timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Node 18+ ya trae fetch global
    const resp = await fetch(url, { ...opts, signal: controller.signal });
    return resp;
  } finally {
    clearTimeout(t);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function safeJsonParse(s) {
  try {
    return JSON.parse(String(s || "").trim());
  } catch {
    return null;
  }
}

/**
 * OpenAI -> TEXT (para polish). Nunca truena: retorna null en fallos.
 */
async function openaiText({ system, user, temperature = 0.7, maxTokens = 220 }) {
  if (PROVIDER !== "openai") return null;
  if (!OPENAI_KEY) return null;

  const url = "https://api.openai.com/v1/chat/completions";
  const body = {
    model: OPENAI_MODEL,
    messages: [
      { role: "system", content: String(system || "") },
      { role: "user", content: String(user || "") }
    ],
    temperature,
    max_tokens: maxTokens
  };

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

      const top = safeJsonParse(raw);
      const content = top?.choices?.[0]?.message?.content;
      const out = String(content || "").trim();
      return out || null;
    } catch (e) {
      await sleep(250 * (i + 1));
    }
  }

  return null;
}

/**
 * OpenAI -> JSON (validado por zod).
 * Nunca truena: retorna null si no cumple schema.
 */
async function openaiJson({ system, user, schema }) {
  if (PROVIDER !== "openai") return null;
  if (!OPENAI_KEY) return null;

  const url = "https://api.openai.com/v1/chat/completions";
  const messages = [
    {
      role: "system",
      content:
        String(system || "") +
        "\n\nResponde SOLO con JSON válido. No agregues texto extra."
    },
    { role: "user", content: String(user || "") }
  ];

  const body = { model: OPENAI_MODEL, messages, temperature: 0 };

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

      const top = safeJsonParse(raw);
      const content = top?.choices?.[0]?.message?.content || "";
      const parsed = safeJsonParse(content);

      if (!parsed) return null;

      const validated = schema.safeParse(parsed);
      if (!validated.success) return null;

      return validated.data;
    } catch {
      await sleep(250 * (i + 1));
    }
  }

  return null;
}

// ===== Public AI functions =====

async function routeIntent(text) {
  const clean = String(text || "").trim();

  // Si viene vacío: default FAQ
  if (!clean) return { intent: "FAQ", confidence: 0.2 };

  const system =
    "Eres un clasificador de intención para un bot de ISP. Etiquetas: CONTRATO, PAGO, FALLA, FAQ.";
  const user =
    `Mensaje del cliente:\n${clean}\n\n` +
    `Devuelve JSON con { "intent": "...", "confidence": 0..1 }`;

  const out = await openaiJson({ system, user, schema: IntentSchema });
  if (!out?.intent) return { intent: "FAQ", confidence: 0.2 };
  return out;
}

/**
 * Extrae colonia sugerida (normalizada) para fuzzy match.
 * Nunca truena; si no puede, regresa guess vacío.
 */
async function extractColoniaHint(text) {
  const clean = String(text || "").trim();
  if (!clean) return { colonia_input: "", colonia_norm_guess: "" };

  const system =
    "Eres un extractor de colonia/domicilio en México. Devuelve SOLO colonia normalizada (sin acentos) o vacío si no se puede.";
  const user =
    `Texto del cliente:\n${clean}\n\n` +
    `Devuelve JSON con:\n` +
    `{ "colonia_input": "<lo que dijo>", "colonia_norm_guess": "<solo colonia normalizada o vacío>" }`;

  const out = await openaiJson({ system, user, schema: ColoniaSchema });
  if (!out) return { colonia_input: clean, colonia_norm_guess: "" };

  const guess = String(out.colonia_norm_guess || "").trim();
  return {
    colonia_input: String(out.colonia_input || clean),
    colonia_norm_guess: guess
  };
}

async function parsePaymentMesMonto(text) {
  const clean = String(text || "").trim();
  if (!clean) return null;

  const system =
    "Eres un extractor de mes y monto de pagos de internet. Si el monto trae coma o punto, respétalo como string.";
  const user = `Texto:\n${clean}\n\nDevuelve JSON { "mes": "...", "monto": "..." }`;

  const out = await openaiJson({ system, user, schema: PaymentParseSchema });
  if (!out?.mes || !out?.monto) return null;
  return out;
}

async function parsePhoneE164(text, fallbackE164) {
  const clean = String(text || "").trim();
  if (!clean && fallbackE164) return { phone_e164: String(fallbackE164) };

  const system =
    "Eres un normalizador de teléfonos México. Si dice 'mismo', usa el fallback. Devuelve E164 +52XXXXXXXXXX.";
  const user =
    `Texto: ${clean}\nFallback: ${fallbackE164}\n\n` +
    `Devuelve JSON { "phone_e164": "+52..." }`;

  const out = await openaiJson({ system, user, schema: PhoneParseSchema });
  if (!out?.phone_e164) return null;
  return out;
}

/**
 * Polish: NO inventa. NO cambia números. Nunca truena.
 */
async function polishReply({ intent, step, rawReply, userText, profileName }) {
  const base = String(rawReply || "").trim();
  if (!base) return "";

  if (PROVIDER !== "openai" || !OPENAI_KEY) return base;

  const name = profileName ? `El cliente se llama ${profileName}.` : "";

  const system = `
Eres un asistente humano profesional de una empresa de internet (InterWIFI) en Encarnación de Díaz, Jalisco.
Objetivo: sonar como persona real: cálida, clara y eficiente.

Reglas estrictas:
- NO digas que eres bot.
- NO inventes datos.
- NO cambies números, horarios, direcciones, cuentas, teléfonos.
- Mensajes cortos y naturales.
- Máximo 1 emoji.
- Máximo 1 pregunta por mensaje.
${name}
  `.trim();

  const user = `
INTENT=${intent || "unknown"} STEP=${step || ""}
Mensaje del cliente: ${String(userText || "")}

Texto base (respétalo, solo mejora estilo/fluidez):
${base}
  `.trim();

  const out = await openaiText({
    system,
    user,
    temperature: 0.6,
    maxTokens: 220
  });

  return String(out || base).trim() || base;
}

module.exports = {
  routeIntent,
  extractColoniaHint,
  parsePaymentMesMonto,
  parsePhoneE164,
  polishReply
};