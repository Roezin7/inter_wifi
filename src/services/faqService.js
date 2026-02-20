// src/services/faqService.js
const { query } = require("../db");
const { norm } = require("../utils/textUtils");

async function getFaqCandidates() {
  const { rows } = await query(
    `SELECT id, question, answer, category, keywords, priority
     FROM wa_faqs
     WHERE active = true
     ORDER BY priority ASC, id ASC`
  );
  return rows || [];
}

function scoreFaq(userTextNorm, faq) {
  let s = 0;
  const q = norm(faq.question || "");
  if (q && userTextNorm.includes(q)) s += 0.5;

  const keys = Array.isArray(faq.keywords) ? faq.keywords : [];
  for (const k of keys) {
    const kk = norm(k);
    if (kk && userTextNorm.includes(kk)) s += 0.25;
  }
  return s;
}

async function matchFaq(text, threshold = 0.6) {
  const t = norm(text || "");
  if (!t) return null;

  const faqs = await getFaqCandidates();
  let best = null;
  let bestScore = 0;

  for (const f of faqs) {
    const sc = scoreFaq(t, f);
    if (sc > bestScore) {
      bestScore = sc;
      best = f;
    }
  }

  if (!best || bestScore < threshold) return null;
  return { ...best, score: bestScore };
}

module.exports = { matchFaq };