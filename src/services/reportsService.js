const { query } = require("../db");
const { withGeneratedFolio } = require("../utils/folio");

function q(client) {
  return client ? client.query.bind(client) : query;
}

async function createReport(payload, client = null) {
  const run = q(client);

  return withGeneratedFolio({
    prefix: "FL",
    insert: async (folio) => {
      const r = await run(
        `insert into reports (folio, phone_e164, nombre, descripcion)
         values ($1,$2,$3,$4)
         returning *`,
        [folio, payload.phoneE164, payload.nombre || null, payload.descripcion || null]
      );

      return r.rows[0];
    }
  });
}

module.exports = { createReport };
