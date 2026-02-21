// src/services/r2UploadService.js
const crypto = require("crypto");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET = process.env.R2_BUCKET;
const R2_PUBLIC_BASE = process.env.R2_PUBLIC_BASE;

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

/**
 * Detecta tipo real por “magic bytes”
 */
function sniffMime(buf) {
  if (!buf || buf.length < 12) return null;

  // PDF: %PDF
  if (buf.slice(0, 4).toString("ascii") === "%PDF") return "application/pdf";

  // JPG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  const pngSig = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
  if (buf.slice(0, 8).equals(pngSig)) return "image/png";

  // WEBP: "RIFF" .... "WEBP"
  if (
    buf.slice(0, 4).toString("ascii") === "RIFF" &&
    buf.slice(8, 12).toString("ascii") === "WEBP"
  ) return "image/webp";

  return null;
}

function safePath(s) {
  return String(s || "")
    .replace(/[^a-zA-Z0-9/_-]+/g, "_")
    .replace(/\/{2,}/g, "/")
    .replace(/^_+|_+$/g, "")
    .slice(0, 180);
}

function sha1(s) {
  return crypto.createHash("sha1").update(String(s || "")).digest("hex").slice(0, 12);
}

async function fetchToBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`download failed ${res.status}: ${t.slice(0, 150)}`);
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
 * - Descarga el binario desde url (aunque sea .enc)
 * - Determina ContentType real por:
 *   (1) mimetype recibido del inbound
 *   (2) header content-type
 *   (3) sniff por bytes (si los anteriores son genéricos)
 * - Sube a R2 con extensión correcta
 */
async function storeToR2({ url, mimetype, folder, filenamePrefix, phoneE164 }) {
  if (!url) throw new Error("storeToR2: missing url");

  const dl = await fetchToBuffer(url);

  const headerCT = dl.contentType || "application/octet-stream";
  const inboundCT = String(mimetype || "").trim();

  // Si viene “application/octet-stream”, intentamos sniff
  const isGeneric =
    /octet-stream/i.test(inboundCT) || /octet-stream/i.test(headerCT) || (!inboundCT && !headerCT);

  const sniffed = isGeneric ? sniffMime(dl.buf) : null;

  const contentType = sniffed || inboundCT || headerCT || "application/octet-stream";
  const ext = extFromMime(contentType);

  const day = new Date().toISOString().slice(0, 10);
  const key = safePath(
    `${folder || "uploads"}/${day}/${filenamePrefix || "file"}_${sha1(phoneE164)}_${sha1(url)}.${ext}`
  );

  const publicUrl = await uploadBufferToR2({ key, buf: dl.buf, contentType });

  return { publicUrl, contentType, key };
}

module.exports = { storeToR2 };