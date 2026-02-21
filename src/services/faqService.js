// src/services/faqService.js
const { query } = require("../db");

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ");
}

function tokenize(s) {
  const t = norm(s);
  if (!t) return [];
  return t.split(" ").filter(Boolean);
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

function keywordHitScore(textNorm, keywords) {
  if (!keywords || !Array.isArray(keywords) || keywords.length === 0) return 0;

  let hits = 0;
  for (const k of keywords) {
    const kk = norm(k);
    if (!kk) continue;
    // hit por substring o por match de palabra
    if (textNorm.includes(kk)) hits++;
  }
  return hits / Math.max(1, keywords.length);
}

/**
 * matchFaq:
 * - trae FAQs activas
 * - calcula score compuesto:
 *   score = 0.55*keywordScore + 0.45*jaccard(questionTokens, inputTokens)
 * - si score >= threshold => matched
 */
async function matchFaq(userText, threshold = 0.62) {
  const textNorm = norm(userText);
  const tokens = tokenize(userText);

  if (!textNorm) {
    return { matched: false, score: 0, faq: null };
  }

  // Traemos un set acotado (activas) ordenadas por prioridad (para desempate)
  const { rows } = await query(
    `
    SELECT id, question, answer, category, keywords, priority
    FROM wa_faqs
    WHERE active = true
    ORDER BY priority DESC, id ASC
    `
  );

  if (!rows?.length) {
    return { matched: false, score: 0, faq: null };
  }

  let best = null;

  for (const f of rows) {
    const qTokens = tokenize(f.question);
    const jac = jaccard(tokens, qTokens);            // 0..1
    const key = keywordHitScore(textNorm, f.keywords); // 0..1

    const score = (0.55 * key) + (0.45 * jac);

    if (!best || score > best.score) {
      best = { score, faq: f };
    }
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

module.exports = {
  matchFaq,
  getFaqById
};