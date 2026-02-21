// src/services/r2UploadService.js
const crypto = require("crypto");
const axios = require("axios");
const path = require("path");

const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

// ====== Config R2 (S3-compatible) ======
function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

const R2_ACCOUNT_ID = requireEnv("R2_ACCOUNT_ID");
const R2_ACCESS_KEY_ID = requireEnv("R2_ACCESS_KEY_ID");
const R2_SECRET_ACCESS_KEY = requireEnv("R2_SECRET_ACCESS_KEY");
const R2_BUCKET = requireEnv("R2_BUCKET");
const R2_PUBLIC_BASE = requireEnv("R2_PUBLIC_BASE"); // ej: https://pub-xxxx.r2.dev  o tu CDN

const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY
  }
});

// ====== Helpers ======
function pickExtFromMime(mime = "") {
  const m = String(mime).toLowerCase();
  if (m.includes("jpeg") || m.includes("jpg")) return ".jpg";
  if (m.includes("png")) return ".png";
  if (m.includes("pdf")) return ".pdf";
  if (m.includes("webp")) return ".webp";
  return ""; // fallback
}

function pickExtFromUrl(url = "") {
  try {
    const u = new URL(url);
    const ext = path.extname(u.pathname || "");
    return ext && ext.length <= 6 ? ext : "";
  } catch {
    return "";
  }
}

function safeName(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[^\w\-]+/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 40);
}

function ymd() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function downloadBinary(url) {
  // OJO: si tu proveedor requiere headers, aquí puedes agregarlos.
  // En la mayoría de setups con WaSender, el link que llega ya es descargable.
  const res = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 30_000,
    maxContentLength: 20 * 1024 * 1024, // 20MB
    maxBodyLength: 20 * 1024 * 1024
  });

  const contentType = res.headers?.["content-type"] || "";
  return {
    buffer: Buffer.from(res.data),
    contentType
  };
}

/**
 * Sube un media a R2 y regresa URL pública
 * @param {Object} params
 * @param {string} params.url - url del provider (mmg/wasender)
 * @param {string} params.mimetype - mimetype reportado por inbound (opcional)
 * @param {string} params.folder - carpeta lógica (ej: "contracts/ine")
 * @param {string} params.filenamePrefix - prefijo del archivo (ej: "ine_frente")
 * @param {string} params.phoneE164 - para namespacing (opcional)
 */
async function storeToR2({ url, mimetype, folder, filenamePrefix, phoneE164 }) {
  if (!url) throw new Error("storeToR2: missing url");

  const { buffer, contentType } = await downloadBinary(url);

  const ext =
    pickExtFromMime(mimetype) ||
    pickExtFromMime(contentType) ||
    pickExtFromUrl(url) ||
    ".bin";

  const rand = crypto.randomBytes(6).toString("hex");
  const phone = safeName(phoneE164 || "unknown");
  const prefix = safeName(filenamePrefix || "file");
  const key = `${folder || "uploads"}/${ymd()}/${phone}/${prefix}_${rand}${ext}`;

  await s3.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: contentType || mimetype || "application/octet-stream"
    })
  );

  const publicUrl = `${R2_PUBLIC_BASE.replace(/\/+$/, "")}/${key}`;
  return { key, publicUrl, contentType: contentType || mimetype || "" };
}

module.exports = { storeToR2 };