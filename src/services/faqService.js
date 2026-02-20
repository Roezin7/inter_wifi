const { query } = require("../db");
const { norm } = require("../utils/textUtils");

async function getFaqCandidates() {
  const r = await query(`select id, question, answer, question_norm from faqs order by id asc`, []);
  return r.rows;
}

function scoreFaq(queryNorm, faqNorm) {
  if (!queryNorm || !faqNorm) return 0;
  if (faqNorm === queryNorm) return 1;

  // token overlap
  const a = new Set(queryNorm.split(" ").filter(Boolean));
  const b = new Set(faqNorm.split(" ").filter(Boolean));
  const inter = [...a].filter((x) => b.has(x)).length;
  const union = new Set([...a, ...b]).size;
  return union ? inter / union : 0;
}

async function matchFaq(text, threshold = 0.7) {
  const qn = norm(text);
  const faqs = await getFaqCandidates();

  let best = null;
  let bestScore = 0;
  for (const f of faqs) {
    const s = scoreFaq(qn, f.question_norm);
    if (s > bestScore) {
      bestScore = s;
      best = f;
    }
  }

  if (best && bestScore >= threshold) {
    return { matched: true, faq: best, score: bestScore };
  }
  return { matched: false, score: bestScore };
}

module.exports = { matchFaq };