// src/services/contractsService.js
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
  // Si quieres 0 colisiones reales: intenta insert y si falla por unique, reintenta.
  // (asumiendo que ya creaste el unique index en folio)
  for (let i = 0; i < 3; i++) {
    const folio = genFolio("CT");

    try {
      const r = await query(
        `insert into contracts
          (folio, phone_e164, nombre, colonia, calle_numero, cobertura, zona, telefono_contacto,
           ine_frente_url, ine_reverso_url, ine_frente_media_id, ine_reverso_media_id,
           ine_frente_mime, ine_reverso_mime)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         returning *`,
        [
          folio,
          payload.phoneE164,
          payload.nombre || null,
          payload.colonia || null,
          payload.calle_numero || null,
          payload.cobertura || null,
          payload.zona || null,
          payload.telefono_contacto || null,
          payload.ine_frente_url || null,
          payload.ine_reverso_url || null,
          payload.ine_frente_media_id || null,
          payload.ine_reverso_media_id || null,
          payload.ine_frente_mime || null,
          payload.ine_reverso_mime || null
        ]
      );
      return r.rows[0];
    } catch (e) {
      // unique violation => reintenta
      if (String(e?.code) === "23505") continue;
      throw e;
    }
  }

  throw new Error("createContract: could not generate unique folio after retries");
}

module.exports = { createContract };