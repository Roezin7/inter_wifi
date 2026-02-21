// src/services/r2UploadService.js
const crypto = require("crypto");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

// ==============
// R2 (S3 compat)
// ==============
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET = process.env.R2_BUCKET;
const R2_PUBLIC_BASE = process.env.R2_PUBLIC_BASE; // ej: https://pub-xxxx.r2.dev o tu CDN

function hasR2Env() {
  return (
    R2_ACCOUNT_ID &&
    R2_ACCESS_KEY_ID &&
    R2_SECRET_ACCESS_KEY &&
    R2_BUCKET &&
    R2_PUBLIC_BASE
  );
}

const r2 = hasR2Env()
  ? new S3Client({
      region: "auto",
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
      },
    })
  : null;

function extFromMime(mime) {
  const m = String(mime || "").toLowerCase();
  if (m.includes("pdf")) return "pdf";
  if (m.includes("png")) return "png";
  if (m.includes("jpeg") || m.includes("jpg")) return "jpg";
  if (m.includes("webp")) return "webp";
  return "bin";
}

function safePath(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9/_-]+/g, "_")
    .replace(/\/{2,}/g, "/")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
}

function sha1(s) {
  return crypto.createHash("sha1").update(String(s || "")).digest("hex").slice(0, 12);
}

async function fetchToBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`download failed ${res.status}: ${t.slice(0, 120)}`);
  }
  const contentType = res.headers.get("content-type") || "application/octet-stream";
  const buf = Buffer.from(await res.arrayBuffer());
  return { buf, contentType };
}

async function uploadBufferToR2({ key, buf, contentType }) {
  if (!r2) throw new Error("R2 not configured (missing env vars)");

  await r2.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: buf,
      ContentType: contentType || "application/octet-stream",
      CacheControl: "public, max-age=31536000, immutable",
    })
  );

  const base = String(R2_PUBLIC_BASE).replace(/\/+$/, "");
  return `${base}/${key}`;
}

/**
 * storeToR2:
 * - Descarga binario desde la URL (aunque sea .enc)
 * - Sube a R2
 * - Regresa URL pública
 */
async function storeToR2({ url, mimetype, folder, filenamePrefix, phoneE164 }) {
  if (!url) throw new Error("storeToR2: missing url");

  const dl = await fetchToBuffer(url);

  const contentType = mimetype || dl.contentType || "application/octet-stream";
  const ext = extFromMime(contentType);
  const day = new Date().toISOString().slice(0, 10);

  const key = safePath(
    [
      folder || "uploads",
      day,
      `${filenamePrefix || "file"}_${sha1(phoneE164)}_${sha1(url)}.${ext}`,
    ].join("/")
  );

  const publicUrl = await uploadBufferToR2({ key, buf: dl.buf, contentType });

  return { publicUrl, contentType, key };
}

module.exports = { storeToR2 };