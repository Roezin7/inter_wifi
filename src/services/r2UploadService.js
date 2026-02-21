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
const R2_PUBLIC_BASE = process.env.R2_PUBLIC_BASE;

const r2 =
  R2_ACCOUNT_ID &&
  R2_ACCESS_KEY_ID &&
  R2_SECRET_ACCESS_KEY &&
  R2_BUCKET &&
  R2_PUBLIC_BASE
    ? new S3Client({
        region: "auto",
        endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId: R2_ACCESS_KEY_ID,
          secretAccessKey: R2_SECRET_ACCESS_KEY,
        },
      })
    : null;

// ==============
// WASENDER
// ==============
const WASENDER_BASE_URL = process.env.WASENDER_BASE_URL; // ej: https://wasenderapi.com/api
const WASENDER_API_KEY = process.env.WASENDER_API_KEY;

// ✅ AJUSTA ESTO A TU WASENDER REAL
// opción A: endpoint directo para descargar binario
function wasenderMediaDownloadUrl(mediaId) {
  return `${WASENDER_BASE_URL}/media/${encodeURIComponent(mediaId)}/download`;
}

function extFromMime(mime) {
  const m = String(mime || "").toLowerCase();
  if (m.includes("pdf")) return "pdf";
  if (m.includes("png")) return "png";
  if (m.includes("jpeg") || m.includes("jpg")) return "jpg";
  if (m.includes("webp")) return "webp";
  return "bin";
}

function sha1(s) {
  return crypto.createHash("sha1").update(String(s || "")).digest("hex").slice(0, 12);
}

function safePath(s) {
  return String(s || "")
    .replace(/[^a-zA-Z0-9/_\.-]+/g, "_")
    .replace(/\/{2,}/g, "/")
    .replace(/^_+|_+$/g, "")
    .slice(0, 240);
}

async function downloadFromWasender(mediaId) {
  if (!WASENDER_BASE_URL || !WASENDER_API_KEY) {
    throw new Error("WASender not configured (missing WASENDER_BASE_URL/WASENDER_API_KEY)");
  }
  if (!mediaId) throw new Error("downloadFromWasender: missing mediaId");

  const url = wasenderMediaDownloadUrl(mediaId);

  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${WASENDER_API_KEY}` },
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`WASender download failed: ${res.status} ${t.slice(0, 200)}`);
  }

  const contentType = res.headers.get("content-type") || "application/octet-stream";
  const buf = Buffer.from(await res.arrayBuffer());
  return { buf, contentType };
}

async function downloadFromUrl(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`download url failed: ${res.status} ${t.slice(0, 200)}`);
  }
  const contentType = res.headers.get("content-type") || "application/octet-stream";
  const buf = Buffer.from(await res.arrayBuffer());
  return { buf, contentType };
}

async function uploadToR2({ key, buf, contentType }) {
  if (!r2) throw new Error("R2 not configured (missing R2 env vars)");

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
 * storeToR2
 * - Si hay mediaId => descarga REAL desde WASender (NO .enc)
 * - Si no hay mediaId => intenta url, pero si es .enc no sirve (cifrado)
 */
async function storeToR2({ providerUrl, mediaId, mime, folder, filenamePrefix, phoneE164 }) {
  const url = String(providerUrl || "");
  const isEnc = /\.enc(\?|$)/i.test(url);

  let dl;

  if (mediaId) {
    dl = await downloadFromWasender(mediaId);
  } else {
    if (isEnc) {
      throw new Error("storeToR2: providerUrl is .enc but no mediaId was provided");
    }
    dl = await downloadFromUrl(url);
  }

  const contentType = String(mime || "").trim() || dl.contentType || "application/octet-stream";
  const ext = extFromMime(contentType);

  const day = new Date().toISOString().slice(0, 10);

  const key = safePath(
    `${folder || "uploads"}/${day}/${filenamePrefix || "file"}_${sha1(phoneE164)}_${sha1(mediaId || url)}.${ext}`
  );

  const publicUrl = await uploadToR2({ key, buf: dl.buf, contentType });

  return { publicUrl, contentType, key };
}

module.exports = { storeToR2 };