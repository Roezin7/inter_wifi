const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const { logger } = require("../../utils/logger");

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function shouldUseSSL(databaseUrl) {
  if (!databaseUrl) return false;

  const u = String(databaseUrl);

  // Si el URL explícitamente lo pide
  if (u.includes("sslmode=require")) return true;

  // Proveedores cloud comunes (casi siempre SSL obligatorio)
  if (u.includes("render.com")) return true;
  if (u.includes("neon.tech")) return true;
  if (u.includes("supabase.com")) return true;
  if (u.includes("railway.app")) return true;
  if (u.includes("heroku.com")) return true;
  if (u.includes("aws") || u.includes("amazonaws.com")) return true;

  return false;
}

const DATABASE_URL = mustEnv("DATABASE_URL");
const USE_SSL = shouldUseSSL(DATABASE_URL);

// Nota: si tu Postgres LOCAL exige SSL, puedes forzarlo con PGSSL=true en .env
const FORCE_SSL = String(process.env.PGSSL || "").toLowerCase() === "true";

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: (USE_SSL || FORCE_SSL) ? { rejectUnauthorized: false } : false
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