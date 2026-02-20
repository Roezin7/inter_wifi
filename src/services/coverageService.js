const { query } = require("../db");
const { norm } = require("../utils/textUtils");

/**
 * Fuzzy simple:
 * - exact norm match
 * - contains match
 * - token overlap
 */
async function findColoniaMatch(inputColonia) {
  const q = norm(inputColonia);
  if (!q) return { found: false };

  // 1) Exact
  let r = await query(
    `select colonia, cobertura, zona, notas
     from coverage_colonias
     where colonia_norm = $1
     limit 1`,
    [q]
  );
  if (r.rows[0]) return { found: true, match: r.rows[0], score: 1.0 };

  // 2) Contains (db contains)
  r = await query(
    `select colonia, cobertura, zona, notas, colonia_norm
     from coverage_colonias
     where colonia_norm like $1
     limit 5`,
    [`%${q}%`]
  );
  if (r.rows[0]) return { found: true, match: r.rows[0], score: 0.85 };

  // 3) Token overlap naive (fetch some)
  const tokens = q.split(" ").filter(Boolean);
  if (tokens.length === 0) return { found: false };

  // Pull candidates by first token
  r = await query(
    `select colonia, cobertura, zona, notas, colonia_norm
     from coverage_colonias
     where colonia_norm like $1
     limit 30`,
    [`%${tokens[0]}%`]
  );

  let best = null;
  let bestScore = 0;
  for (const row of r.rows) {
    const t2 = row.colonia_norm.split(" ");
    const overlap = tokens.filter((t) => t2.includes(t)).length;
    const score = overlap / Math.max(tokens.length, 1);
    if (score > bestScore) {
      bestScore = score;
      best = row;
    }
  }

  if (best && bestScore >= 0.5) {
    return { found: true, match: best, score: bestScore };
  }
  return { found: false };
}

module.exports = { findColoniaMatch };