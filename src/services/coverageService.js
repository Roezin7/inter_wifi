// src/services/coverageService.js
const { query } = require("../db");
const { norm } = require("../utils/textUtils");

async function findColoniaMatch(userText, limit = 5) {
  const t = norm(userText || "");
  if (!t) return [];

  // buscamos parecido sobre name_norm usando pg_trgm
  const { rows } = await query(
    `
    SELECT name_display, similarity(name_norm, $1) AS sim
    FROM coverage_colonias
    WHERE active = true
      AND name_norm % $1
    ORDER BY sim DESC
    LIMIT $2
    `,
    [t, limit]
  );

  return rows || [];
}

module.exports = { findColoniaMatch };