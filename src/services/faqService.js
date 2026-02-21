// src/services/faqService.js
const { query } = require("../db");

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ");
}

function detectCategory(textNorm) {
  // categorías que YA tienes: "info" y "pagos"
  // (puedes agregar "precios" etc cuando exista en DB)
  if (/(pago|pagu|deposit|dep[oó]sit|transfer|comprobante|ticket|recibo|oxxo|spin|azteca|tarjeta|credito|d[eé]bito|vencim|corte)/i.test(textNorm)) {
    return "pagos";
  }
  if (/(ubic|direc|donde|mapa|lleg|horario|abren|cierran|oficina|atenci)/i.test(textNorm)) {
    return "info";
  }
  return null;
}

/**
 * matchFaq:
 * - intenta match por keywords (rápido y súper confiable)
 * - si no, intenta trigram similarity en question
 */
async function matchFaq(userText, opts = {}) {
  const limit = Number(opts.limit || 5);
  const threshold = Number(opts.threshold || 0.25); // trigram threshold (0.2-0.35 suele ir bien)
  const t = norm(userText);
  if (!t) return { matched: false };

  const category = opts.category || detectCategory(t);

  // 1) KEYWORDS MATCH (determinístico)
  // keywords es text[] => buscamos si el mensaje contiene alguno
  // ordenamos por:
  // - cantidad de keywords pegadas (desc)
  // - priority (desc)
  // - updated_at (desc)
  const kwSql = `
    WITH c AS (
      SELECT
        id, question, answer, category, keywords, active, priority, updated_at,
        (
          SELECT COUNT(*)
          FROM unnest(keywords) k
          WHERE $1 LIKE ('%' || lower(k) || '%')
        ) AS kw_hits
      FROM wa_faqs
      WHERE active = true
        AND ( $2::text IS NULL OR category = $2::text )
    )
    SELECT *
    FROM c
    WHERE kw_hits > 0
    ORDER BY kw_hits DESC, priority DESC, updated_at DESC
    LIMIT $3
  `;

  const kwRes = await query(kwSql, [t, category, limit]);
  if (kwRes.rows?.length) {
    const top = kwRes.rows[0];
    return {
      matched: true,
      reason: "keywords",
      score: Number(top.kw_hits || 0),
      faq: top
    };
  }

  // 2) TRGM MATCH (backup)
  const trgmSql = `
    SELECT
      id, question, answer, category, keywords, active, priority, updated_at,
      similarity(lower(question), $1) AS sim
    FROM wa_faqs
    WHERE active = true
      AND ( $2::text IS NULL OR category = $2::text )
    ORDER BY sim DESC, priority DESC, updated_at DESC
    LIMIT $3
  `;
  const triRes = await query(trgmSql, [t, category, limit]);
  const top = triRes.rows?.[0];

  if (top && Number(top.sim || 0) >= threshold) {
    return {
      matched: true,
      reason: "trgm",
      score: Number(top.sim || 0),
      faq: top
    };
  }

  return { matched: false, reason: "no_match", category };
}

module.exports = { matchFaq };