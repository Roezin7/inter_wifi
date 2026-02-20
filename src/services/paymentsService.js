const { query } = require("../db");
const { genFolio } = require("./reportsService"); // reuse helper? (we’ll duplicate to avoid circular)
function gen(prefix) {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const rnd = Math.floor(Math.random() * 1e6).toString().padStart(6, "0");
  return `${prefix}-${y}${m}${day}-${rnd}`;
}

async function createPayment(payload) {
  const folio = gen("PG");
  const r = await query(
    `insert into payments (folio, phone_e164, nombre, mes, monto, comprobante_url)
     values ($1,$2,$3,$4,$5,$6)
     returning *`,
    [
      folio,
      payload.phoneE164,
      payload.nombre || null,
      payload.mes || null,
      payload.monto || null,
      payload.comprobante_url || null
    ]
  );
  return r.rows[0];
}

module.exports = { createPayment };