const { query } = require("../db");

function genFolio(prefix) {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const rnd = Math.floor(Math.random() * 1e6).toString().padStart(6, "0");
  return `${prefix}-${y}${m}${day}-${rnd}`;
}

async function createContract(payload) {
  const folio = genFolio("CT");
  const r = await query(
    `insert into contracts
     (folio, phone_e164, nombre, colonia, cobertura, zona, telefono_contacto, ine_frente_url, ine_reverso_url)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     returning *`,
    [
      folio,
      payload.phoneE164,
      payload.nombre || null,
      payload.colonia || null,
      payload.cobertura || null,
      payload.zona || null,
      payload.telefono_contacto || null,
      payload.ine_frente_url || null,
      payload.ine_reverso_url || null
    ]
  );
  return r.rows[0];
}

module.exports = { createContract };