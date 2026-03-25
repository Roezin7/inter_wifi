// src/services/paymentsService.js
const { query } = require("../db");
const { withGeneratedFolio } = require("../utils/folio");

function q(client) {
  return client ? client.query.bind(client) : query;
}

async function createPayment(payload, client = null) {
  const run = q(client);

  return withGeneratedFolio({
    prefix: "PG",
    insert: async (folio) => {
      const r = await run(
        `insert into payments (
            folio, phone_e164, nombre, mes, monto,
            comprobante_url, comprobante_media_id, comprobante_mime, comprobante_public_url
         )
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         returning *`,
        [
          folio,
          payload.phoneE164,
          payload.nombre || null,
          payload.mes || null,
          payload.monto || null,
          payload.comprobante_url || null,
          payload.comprobante_media_id || null,
          payload.comprobante_mime || null,
          payload.comprobante_public_url || null,
        ]
      );

      return r.rows[0];
    }
  });
}

module.exports = { createPayment };
