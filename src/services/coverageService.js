// src/services/coverageService.js
const { query } = require("../db");
const { norm } = require("../utils/textUtils");

async function findColoniaCandidates(userText, limit = 5) {
  const t = norm(userText || "");
  if (!t) return [];

  const { rows } = await query(
    `
    SELECT
      name_display,
      similarity(name_norm, $1) AS sim
    FROM coverage_colonias_v2
    WHERE active = true
      AND name_norm % $1
    ORDER BY sim DESC
    LIMIT $2
    `,
    [t, limit]
  );

  return rows || [];
}

/**
 * Resuelve colonia:
 * - autoAccept si similarity alta y gap contra 2do candidato
 * - si no, devuelve candidatos para confirmar
 */
async function resolveColonia(userText, { limit = 5 } = {}) {
  const candidates = await findColoniaCandidates(userText, limit);

  if (!candidates.length) {
    return { ok: false, reason: "NO_MATCH", candidates: [] };
  }

  const best = candidates[0];
  const second = candidates[1];

  const sim1 = Number(best.sim || 0);
  const sim2 = Number(second?.sim || 0);
  const gap = sim1 - sim2;

  // ajusta thresholds si quieres más/menos agresivo
  const autoAccept = sim1 >= 0.70 && (candidates.length === 1 || gap >= 0.08);

  return {
    ok: true,
    autoAccept,
    best: { colonia: best.name_display, sim: sim1 },
    candidates: candidates.map((c) => ({
      colonia: c.name_display,
      sim: Number(c.sim || 0)
    }))
  };
}

module.exports = { findColoniaCandidates, resolveColonia };