// src/services/faqService.js
const { query } = require("../db");

/**
 * Normalización PRO:
 * - lowercase
 * - quita acentos
 * - limpia símbolos/emoji
 * - colapsa espacios
 */
function norm(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // diacríticos
    .trim()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ");
}

function stemToken(t) {
  // súper simple: plural final
  if (!t) return "";
  if (t.length > 4 && t.endsWith("s")) return t.slice(0, -1);
  return t;
}

function tokenize(s) {
  const t = norm(s);
  if (!t) return [];
  return t.split(" ").filter(Boolean).map(stemToken);
}

function jaccard(aTokens, bTokens) {
  const A = new Set(aTokens);
  const B = new Set(bTokens);
  if (A.size === 0 || B.size === 0) return 0;

  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;

  const union = A.size + B.size - inter;
  return union ? inter / union : 0;
}

/**
 * Keyword score PRO:
 * - ya NO divide por todas las keywords (eso castigaba mucho)
 * - si hay 1 hit => base alto
 * - más hits => sube, con tope
 */
function keywordHitScore(textNorm, keywords) {
  if (!keywords || !Array.isArray(keywords) || keywords.length === 0) return 0;

  let hits = 0;

  for (const k of keywords) {
    const kk = norm(k);
    if (!kk) continue;

    // match por substring
    if (textNorm.includes(kk)) {
      hits++;
      continue;
    }

    // match por token (y singular/plural)
    const tt = textNorm.split(" ").map(stemToken);
    const kt = kk.split(" ").map(stemToken);

    // si todos los tokens de keyword están presentes (para frases tipo "banco azteca")
    const ok = kt.every((x) => tt.includes(x));
    if (ok) hits++;
  }

  if (hits <= 0) return 0;

  // base fuerte por primer hit + extra por adicionales con saturación
  // 1 hit => 0.78  | 2 hits => 0.88 | 3 hits => 0.95 | >=4 => 1.0
  return Math.min(1, 0.70 + 0.10 * hits);
}

/**
 * Optional: “boost” si el input es muy corto y coincide con categoría canónica
 */
function canonicalIntent(textNorm) {
  const t = norm(textNorm);

  if (/^(horario|horarios)$/.test(t)) return "horarios";
  if (/^(ubicacion|direccion|donde|donde estan|donde estan ubicados)$/.test(t)) return "ubicacion";
  if (/^(pago|pagos|formas de pago|deposito|transferencia|oxxo|spin|azteca)$/.test(t)) return "pagos";
  if (/^(precio|precios|paquete|paquetes|plan|planes)$/.test(t)) return "precios";

  return null;
}

/**
 * matchFaq:
 * score robusto:
 * - keywordHitScore (muy determinante)
 * - jaccard de pregunta
 * - boost canónico (horarios/ubicacion/pagos/precios)
 */
async function matchFaq(userText, threshold = 0.62) {
  const textNorm = norm(userText);
  const tokens = tokenize(userText);

  if (!textNorm) return { matched: false, score: 0, faq: null };

  const { rows } = await query(
    `
    SELECT id, question, answer, category, keywords, priority
    FROM wa_faqs
    WHERE active = true
    ORDER BY priority DESC, id ASC
    `
  );

  if (!rows?.length) return { matched: false, score: 0, faq: null };

  const canon = canonicalIntent(textNorm);

  let best = null;

  for (const f of rows) {
    const qTokens = tokenize(f.question);
    const jac = jaccard(tokens, qTokens); // 0..1
    const key = keywordHitScore(textNorm, f.keywords); // 0..1

    let score = (0.70 * key) + (0.30 * jac);

    // boost si input es canónico y la faq cae en esa categoría
    if (canon) {
      const c = norm(f.category);
      if (canon === "horarios" && c === "info") score = Math.min(1, score + 0.20);
      if (canon === "ubicacion" && c === "info") score = Math.min(1, score + 0.20);
      if (canon === "pagos" && c === "pagos") score = Math.min(1, score + 0.20);
      if (canon === "precios" && c === "precios") score = Math.min(1, score + 0.20);
    }

    if (!best || score > best.score) best = { score, faq: f };
  }

  if (!best) return { matched: false, score: 0, faq: null };

  const matched = best.score >= threshold;

  return {
    matched,
    score: Number(best.score.toFixed(4)),
    faq: matched ? best.faq : null
  };
}

async function getFaqById(id) {
  const { rows } = await query(
    `
    SELECT id, question, answer, category, keywords, priority, active
    FROM wa_faqs
    WHERE id = $1
    LIMIT 1
    `,
    [id]
  );
  return rows[0] || null;
}

async function listFaqsByCategory(category) {
  const { rows } = await query(
    `
    SELECT id, question, answer, category, keywords, priority
    FROM wa_faqs
    WHERE active = true AND category = $1
    ORDER BY priority DESC, id ASC
    `,
    [category]
  );
  return rows || [];
}

module.exports = {
  matchFaq,
  getFaqById,
  listFaqsByCategory,
  norm
};