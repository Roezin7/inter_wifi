// src/services/r2UploadService.js
const crypto = require("crypto");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

// ===================
// R2 (S3 compatible)
// ===================
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET = process.env.R2_BUCKET;
const R2_PUBLIC_BASE = process.env.R2_PUBLIC_BASE; // https://pub-xxx.r2.dev o tu CDN

function requiredEnvOk() {
  return (
    R2_ACCOUNT_ID &&
    R2_ACCESS_KEY_ID &&
    R2_SECRET_ACCESS_KEY &&
    R2_BUCKET &&
    R2_PUBLIC_BASE
  );
}

const r2 = requiredEnvOk()
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
  if (m.includes("gif")) return "gif";
  return "bin";
}

function sha1(s) {
  return crypto.createHash("sha1").update(String(s || "")).digest("hex").slice(0, 12);
}

// ==============
// WhatsApp HKDF
// ==============
function getInfoLabel(mediaType) {
  // según WA spec / docs de Wasender
  const map = {
    image: "WhatsApp Image Keys",
    sticker: "WhatsApp Image Keys",
    video: "WhatsApp Video Keys",
    audio: "WhatsApp Audio Keys",
    document: "WhatsApp Document Keys",
  };
  return map[mediaType] || null;
}

function detectMediaTypeFromMime(mime) {
  const m = String(mime || "").toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  if (m === "application/pdf") return "document";
  if (m.startsWith("application/")) return "document";
  return "document";
}

async function hkdfSha256(ikm, info, len) {
  return new Promise((resolve, reject) => {
    crypto.hkdf("sha256", ikm, Buffer.alloc(0), info, len, (err, derivedKey) => {
      if (err) return reject(err);
      resolve(Buffer.from(derivedKey));
    });
  });
}

async function decryptWhatsAppMedia({ encBuf, mediaKeyB64, mediaType }) {
  const info = getInfoLabel(mediaType);
  if (!info) throw new Error(`Invalid mediaType for HKDF: ${mediaType}`);

  const mediaKey = Buffer.from(mediaKeyB64, "base64");
  const derived = await hkdfSha256(mediaKey, info, 112);

  const iv = derived.slice(0, 16);
  const cipherKey = derived.slice(16, 48);

  // WA: últimos 10 bytes son MAC => se recorta para descifrar
  const ciphertext = encBuf.slice(0, -10);

  const decipher = crypto.createDecipheriv("aes-256-cbc", cipherKey, iv);
  const dec = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return dec;
}

async function fetchBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Download failed: ${res.status} ${t.slice(0, 200)}`);
  }
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

async function putToR2({ key, buf, contentType }) {
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
 * storeToR2
 * - Descarga .enc desde Wasender URL
 * - Descifra con mediaKey
 * - Sube a R2 con mimetype real y extensión correcta
 */
async function storeToR2({
  url,
  mediaKey,
  mimetype,
  fileName,
  folder = "uploads",
  filenamePrefix = "file",
  phoneE164 = "",
}) {
  if (!url) throw new Error("storeToR2: missing url");
  if (!mediaKey) throw new Error("storeToR2: missing mediaKey");
  if (!mimetype) throw new Error("storeToR2: missing mimetype");

  const mediaType = detectMediaTypeFromMime(mimetype);

  const encBuf = await fetchBuffer(url);
  if (!encBuf?.length) throw new Error("storeToR2: empty encrypted buffer");

  const decBuf = await decryptWhatsAppMedia({
    encBuf,
    mediaKeyB64: mediaKey,
    mediaType,
  });

  const ext = extFromMime(mimetype);

  // nombre final
  const key = [
    String(folder || "uploads").replace(/^\/+|\/+$/g, ""),
    new Date().toISOString().slice(0, 10),
    `${filenamePrefix}_${sha1(phoneE164)}_${sha1(url)}.${ext}`,
  ].join("/");

  const publicUrl = await putToR2({ key, buf: decBuf, contentType: mimetype });

  return {
    publicUrl,
    contentType: mimetype,
    key,
    size: decBuf.length,
    originalFileName: fileName || null,
  };
}

module.exports = { storeToR2 };