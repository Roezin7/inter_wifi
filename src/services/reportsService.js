const { query } = require("../db");

function genFolio(prefix) {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const rnd = Math.floor(Math.random() * 1e6).toString().padStart(6, "0");
  return `${prefix}-${y}${m}${day}-${rnd}`;
}

async function createReport(payload) {
  const folio = genFolio("FL");
  const r = await query(
    `insert into reports (folio, phone_e164, nombre, descripcion)
     values ($1,$2,$3,$4)
     returning *`,
    [folio, payload.phoneE164, payload.nombre || null, payload.descripcion || null]
  );
  return r.rows[0];
}

module.exports = { genFolio, createReport };