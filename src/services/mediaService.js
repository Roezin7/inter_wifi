// src/services/mediaService.js
const crypto = require("crypto");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

// =======================
// FETCH (Node 18+ native)
// =======================
/**
 * En Node 18+ (incluye Node 22) existe fetch global.
 * Si algún día corres en Node viejo, te dará error explícito.
 */
const fetchFn = global.fetch;
if (!fetchFn) {
  throw new Error(
    "mediaService: global.fetch is not available. Use Node 18+ (recommended) or add a fetch polyfill."
  );
}

// ==============
// R2 (S3 compat)
// ==============
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET = process.env.R2_BUCKET;
const R2_PUBLIC_BASE = process.env.R2_PUBLIC_BASE; // ej: https://cdn.tudominio.com o https://pub-xxx.r2.dev

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
const WASENDER_API_KEY = process.env.WASENDER_API_KEY; // tu key/token

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

async function downloadFromWasender({ mediaId }) {
  if (!WASENDER_BASE_URL || !WASENDER_API_KEY) return null;
  if (!mediaId) return null;

  // ⚠️ AJUSTA ESTE ENDPOINT A TU WASENDER REAL
  // La idea es: que regrese binario del archivo
  const url = `${WASENDER_BASE_URL}/media/${encodeURIComponent(mediaId)}/download`;

  const res = await fetchFn(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${WASENDER_API_KEY}`,
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Wasender media download failed: ${res.status} ${text?.slice(0, 200)}`);
  }

  const contentType = res.headers.get("content-type") || "application/octet-stream";
  const buf = Buffer.from(await res.arrayBuffer());

  return { buf, contentType };
}

async function uploadToR2({ key, buf, contentType }) {
  if (!r2) return null;

  await r2.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: buf,
      ContentType: contentType,
      CacheControl: "public, max-age=31536000, immutable",
    })
  );

  // URL pública
  const base = String(R2_PUBLIC_BASE).replace(/\/+$/, "");
  return `${base}/${key}`;
}

/**
 * Intenta resolver la url pública del comprobante.
 * - Si ya es una URL normal (jpg/pdf), la regresa
 * - Si es .enc, intenta descargar por mediaId y subir a R2
 */
async function resolveAndStoreMedia({ providerUrl, mediaId, mime, phoneE164, kind }) {
  const url = String(providerUrl || "");
  const isEnc = /\.enc(\?|$)/i.test(url);

  // si ya es algo normal, no hacemos nada
  if (url && !isEnc) {
    return { publicUrl: url, contentType: mime || null, source: "as_is" };
  }

  // si no hay mediaId, NO hay forma confiable de convertir .enc
  if (!mediaId) {
    return { publicUrl: null, contentType: mime || null, source: "no_media_id" };
  }

  // descarga binario
  const dl = await downloadFromWasender({ mediaId });
  if (!dl?.buf?.length) return { publicUrl: null, contentType: mime || null, source: "empty" };

  const contentType = mime || dl.contentType || "application/octet-stream";
  const ext = extFromMime(contentType);

  const key = [
    "uploads",
    kind || "media",
    new Date().toISOString().slice(0, 10),
    `${sha1(phoneE164)}_${sha1(mediaId)}.${ext}`,
  ].join("/");

  const publicUrl = await uploadToR2({ key, buf: dl.buf, contentType });

  return { publicUrl: publicUrl || null, contentType, source: publicUrl ? "r2" : "no_r2" };
}

module.exports = { resolveAndStoreMedia };