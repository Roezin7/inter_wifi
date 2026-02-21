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
  if (!t) return "";
  if (t.length > 4 && t.endsWith("s")) return t.slice(0, -1); // plural simple
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
  if (!A.size || !B.size) return 0;

  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const union = A.size + B.size - inter;
  return union ? inter / union : 0;
}

/**
 * Keyword score PRO:
 * - 1 hit ya da score alto
 * - más hits sube con saturación
 */
function keywordHitScore(textNorm, keywords) {
  if (!keywords || !Array.isArray(keywords) || keywords.length === 0) return 0;

  let hits = 0;
  const tt = textNorm.split(" ").map(stemToken);

  for (const k of keywords) {
    const kk = norm(k);
    if (!kk) continue;

    if (textNorm.includes(kk)) {
      hits++;
      continue;
    }

    const kt = kk.split(" ").map(stemToken);
    const ok = kt.every((x) => tt.includes(x));
    if (ok) hits++;
  }

  if (hits <= 0) return 0;
  return Math.min(1, 0.70 + 0.10 * hits);
}

function canonicalIntent(textNorm) {
  const t = norm(textNorm);

  if (/^(horario|horarios)$/.test(t)) return "horarios";
  if (/^(ubicacion|direccion|donde|donde estan|donde estan ubicados)$/.test(t)) return "ubicacion";
  if (/^(pago|pagos|forma de pago|formas de pago|como pagar|donde pagar|deposito|transferencia|oxxo|spin|azteca)$/.test(t)) return "pagos";
  if (/^(precio|precios|paquete|paquetes|plan|planes|cuanto cuesta|cuánto cuesta)$/.test(t)) return "precios";

  return null;
}

/**
 * matchFaq:
 * - trae FAQs activas
 * - score robusto: 0.70 keyword + 0.30 jaccard
 * - boost canónico por categoría
 * - NO filtra kind aquí: el handler decide si quiere SUMMARY/DETAIL
 */
async function matchFaq(userText, threshold = 0.62) {
  const textNorm = norm(userText);
  const tokens = tokenize(userText);
  if (!textNorm) return { matched: false, score: 0, faq: null };

  const { rows } = await query(
    `
    SELECT id, question, answer, category, keywords, priority, kind, group_key
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
    const jac = jaccard(tokens, qTokens);
    const key = keywordHitScore(textNorm, f.keywords);

    let score = (0.70 * key) + (0.30 * jac);

    // boost canónico por categoría
    if (canon) {
      const cat = norm(f.category);
      if ((canon === "horarios" || canon === "ubicacion") && cat === "info") score = Math.min(1, score + 0.20);
      if (canon === "pagos" && cat === "pagos") score = Math.min(1, score + 0.20);
      if (canon === "precios" && cat === "precios") score = Math.min(1, score + 0.20);
    }

    if (!best || score > best.score) best = { score, faq: f };
  }

  const matched = best && best.score >= threshold;

  return {
    matched,
    score: Number((best?.score || 0).toFixed(4)),
    faq: matched ? best.faq : null
  };
}

async function getFaqById(id) {
  const { rows } = await query(
    `
    SELECT id, question, answer, category, keywords, priority, active, kind, group_key
    FROM wa_faqs
    WHERE id = $1
    LIMIT 1
    `,
    [id]
  );
  return rows[0] || null;
}

async function getFaqSummaryByGroup(groupKey) {
  const { rows } = await query(
    `
    SELECT id, question, answer, category, keywords, priority, kind, group_key
    FROM wa_faqs
    WHERE active = true AND kind = 'SUMMARY' AND group_key = $1
    ORDER BY priority DESC, id ASC
    LIMIT 1
    `,
    [groupKey]
  );
  return rows[0] || null;
}

async function listFaqsByCategory(category, { kind = null } = {}) {
  const params = [category];
  let kindSql = "";

  if (kind) {
    params.push(kind);
    kindSql = " AND kind = $2 ";
  }

  const { rows } = await query(
    `
    SELECT id, question, answer, category, keywords, priority, kind, group_key
    FROM wa_faqs
    WHERE active = true AND category = $1
    ${kindSql}
    ORDER BY priority DESC, id ASC
    `,
    params
  );

  return rows || [];
}

module.exports = {
  norm,
  matchFaq,
  getFaqById,
  getFaqSummaryByGroup,
  listFaqsByCategory,
  canonicalIntent
};