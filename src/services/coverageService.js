// src/services/coverageService.js
const { query } = require("../db");
const { norm } = require("../utils/textUtils");

/**
 * Devuelve candidatos (máx limit) ordenados por similitud.
 * Cada candidato trae: { name_display, name_norm, cobertura, zona, sim }
 */
async function findColoniaCandidates(userText, limit = 5) {
  const t = norm(userText || "");
  if (!t) return [];

  const { rows } = await query(
    `
    SELECT
      name_display,
      name_norm,
      cobertura,
      zona,
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
 * Decide si es "auto-accept" o requiere confirmación.
 * - autoAccept si sim >= 0.65 y (gap >= 0.08 vs #2 o solo hay 1)
 * Ajusta thresholds a tu data real.
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

  const autoAccept = sim1 >= 0.65 && (candidates.length === 1 || gap >= 0.08);

  return {
    ok: true,
    autoAccept,
    best: {
      colonia: best.name_display,
      cobertura: best.cobertura,
      zona: best.zona || null,
      sim: sim1
    },
    candidates: candidates.map((c) => ({
      colonia: c.name_display,
      cobertura: c.cobertura,
      zona: c.zona || null,
      sim: Number(c.sim || 0)
    }))
  };
}

module.exports = { findColoniaCandidates, resolveColonia };