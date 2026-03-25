// src/services/contractsService.js
const { query } = require("../db");
const { withGeneratedFolio } = require("../utils/folio");

function q(client) {
  return client ? client.query.bind(client) : query;
}

async function createContract(payload, client = null) {
  const run = q(client);

  return withGeneratedFolio({
    prefix: "CT",
    insert: async (folio) => {
      const r = await run(
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
    }
  });
}

module.exports = { createContract };
