const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const { logger } = require("../src/utils/logger");

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

const pool = new Pool({
  connectionString: mustEnv("DATABASE_URL"),
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false
});

async function query(text, params) {
  return pool.query(text, params);
}

/**
 * Idempotente: crea tablas si no existen
 */
async function runMigrations() {
  const sqlPath = path.join(__dirname, "migrations.sql");
  const sql = fs.readFileSync(sqlPath, "utf8");
  await pool.query(sql);
  logger.info("Migrations OK");
}

module.exports = { pool, query, runMigrations };