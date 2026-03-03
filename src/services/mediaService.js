// src/services/mediaService.js
const crypto = require("crypto");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

// =======================
// FETCH (Node 18+ native)
// =======================
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

// =======================
// Helpers
// =======================
function extFromMime(mime) {
  const m = String(mime || "").toLowerCase();
  if (m.includes("pdf")) return "pdf";
  if (m.includes("png")) return "png";
  if (m.includes("jpeg") || m.includes("jpg")) return "jpg";
  if (m.includes("webp")) return "webp";
  if (m.includes("heic")) return "heic";
  return "bin";
}

function sha1(s) {
  return crypto.createHash("sha1").update(String(s || "")).digest("hex").slice(0, 12);
}

function isEncUrl(url) {
  return /\.enc(\?|$)/i.test(String(url || ""));
}

function b64ToBuf(b64) {
  try {
    return Buffer.from(String(b64 || ""), "base64");
  } catch {
    return null;
  }
}

function hkdfSha256(ikm, length, info) {
  // HKDF-Extract(salt="", IKM) -> PRK
  const prk = crypto.createHmac("sha256", Buffer.alloc(0)).update(ikm).digest();

  // HKDF-Expand(PRK, info, L)
  const infoBuf = Buffer.from(String(info || ""), "utf8");
  let t = Buffer.alloc(0);
  let okm = Buffer.alloc(0);
  let i = 0;

  while (okm.length < length) {
    i += 1;
    t = crypto
      .createHmac("sha256", prk)
      .update(Buffer.concat([t, infoBuf, Buffer.from([i])]))
      .digest();
    okm = Buffer.concat([okm, t]);
  }

  return okm.slice(0, length);
}

function waInfoLabel(kind, mimetype) {
  // WhatsApp usa labels distintas según el tipo
  // Para imágenes en general:
  // "WhatsApp Image Keys"
  // Video:
  // "WhatsApp Video Keys"
  // Audio:
  // "WhatsApp Audio Keys"
  // Documento:
  // "WhatsApp Document Keys"
  const k = String(kind || "").toLowerCase();
  const m = String(mimetype || "").toLowerCase();

  if (k === "image" || m.startsWith("image/")) return "WhatsApp Image Keys";
  if (k === "video" || m.startsWith("video/")) return "WhatsApp Video Keys";
  if (k === "audio" || m.startsWith("audio/")) return "WhatsApp Audio Keys";
  return "WhatsApp Document Keys";
}

async function downloadBinary(url) {
  const res = await fetchFn(url, { method: "GET" });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`download failed: ${res.status} ${text.slice(0, 200)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return { buf, contentType: res.headers.get("content-type") || null };
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

  const base = String(R2_PUBLIC_BASE).replace(/\/+$/, "");
  return `${base}/${key}`;
}

/**
 * Decrypt WhatsApp .enc media
 * Algoritmo:
 * - mediaKey (base64) -> bytes
 * - HKDF-SHA256(mediaKey, 112, infoLabel)
 * - iv = okm[0..15], cipherKey = okm[16..47], macKey = okm[48..79]
 * - file = ciphertext || mac (10 bytes)
 * - mac = HMAC-SHA256(macKey, iv || ciphertext) trunc(10)
 * - plaintext = AES-256-CBC(cipherKey, iv).decrypt(ciphertext)
 */
function decryptWhatsAppEnc({ encBuf, mediaKeyB64, infoLabel }) {
  const mediaKey = b64ToBuf(mediaKeyB64);
  if (!mediaKey || mediaKey.length < 16) {
    return { ok: false, reason: "bad_mediaKey" };
  }

  if (!encBuf || encBuf.length < 32) {
    return { ok: false, reason: "enc_too_small" };
  }

  // Derivar OKM
  const okm = hkdfSha256(mediaKey, 112, infoLabel);
  const iv = okm.slice(0, 16);
  const cipherKey = okm.slice(16, 48); // 32
  const macKey = okm.slice(48, 80); // 32

  // WhatsApp: último 10 bytes = mac
  const macSize = 10;
  if (encBuf.length <= macSize + 16) {
    return { ok: false, reason: "enc_invalid_len" };
  }

  const ciphertext = encBuf.slice(0, encBuf.length - macSize);
  const mac = encBuf.slice(encBuf.length - macSize);

  // Verificación MAC (si falla, igual intentamos decrypt pero marcamos)
  let macOk = false;
  try {
    const calc = crypto.createHmac("sha256", macKey).update(Buffer.concat([iv, ciphertext])).digest();
    const calcTrunc = calc.slice(0, macSize);
    macOk = crypto.timingSafeEqual(calcTrunc, mac);
  } catch {
    macOk = false;
  }

  // Decrypt AES-256-CBC
  try {
    const decipher = crypto.createDecipheriv("aes-256-cbc", cipherKey, iv);
    decipher.setAutoPadding(true);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

    if (!plain || !plain.length) return { ok: false, reason: "decrypt_empty", macOk };

    return { ok: true, buf: plain, macOk };
  } catch (e) {
    return { ok: false, reason: "decrypt_failed", macOk, err: e?.message || String(e) };
  }
}

/**
 * resolveAndStoreMedia (PRO)
 * - Si URL no es .enc: regresa tal cual
 * - Si es .enc: descarga -> decrypt WhatsApp con mediaKey -> sube a R2 -> regresa URL pública
 *
 * Params:
 * - providerUrl: url de mmg.whatsapp.net ... .enc
 * - mediaKey: base64
 * - mime: mimetype (image/jpeg)
 * - phoneE164: para key
 * - kind: image/video/audio/document (para label hkdf + folder)
 * - folder: (opcional) override folder
 * - filenamePrefix: (opcional)
 */
async function resolveAndStoreMedia({
  providerUrl,
  mediaKey,
  mime,
  phoneE164,
  kind = "document",
  folder,
  filenamePrefix,
}) {
  const url = String(providerUrl || "").trim();
  if (!url) return { publicUrl: null, contentType: mime || null, source: "no_url", reason: "no_url" };

  // No .enc => úsala tal cual
  if (!isEncUrl(url)) {
    return { publicUrl: url, contentType: mime || null, source: "as_is" };
  }

  if (!mediaKey) {
    return {
      publicUrl: null,
      contentType: mime || null,
      source: "no_mediaKey",
      reason: "no_mediaKey",
    };
  }

  // 1) descarga .enc
  let enc;
  try {
    enc = await downloadBinary(url);
  } catch (e) {
    return {
      publicUrl: null,
      contentType: mime || null,
      source: "download_failed",
      reason: "download_failed",
      err: e?.message || String(e),
    };
  }

  // 2) decrypt
  const infoLabel = waInfoLabel(kind, mime);
  const dec = decryptWhatsAppEnc({
    encBuf: enc.buf,
    mediaKeyB64: mediaKey,
    infoLabel,
  });

  if (!dec.ok) {
    return {
      publicUrl: null,
      contentType: mime || null,
      source: "decrypt_failed",
      reason: dec.reason || "decrypt_failed",
      macOk: dec.macOk,
      err: dec.err,
    };
  }

  // 3) subir a R2
  const contentType = mime || enc.contentType || "application/octet-stream";
  const ext = extFromMime(contentType);

  const date = new Date().toISOString().slice(0, 10);
  const key = [
    String(folder || `uploads/${kind || "media"}`),
    date,
    `${String(filenamePrefix || "file")}_${sha1(phoneE164)}_${sha1(url)}.${ext}`,
  ]
    .join("/")
    .replace(/\/+/g, "/");

  let publicUrl;
  try {
    publicUrl = await uploadToR2({ key, buf: dec.buf, contentType });
  } catch (e) {
    return {
      publicUrl: null,
      contentType,
      source: "r2_upload_failed",
      reason: "r2_upload_failed",
      macOk: dec.macOk,
      err: e?.message || String(e),
    };
  }

  return {
    publicUrl: publicUrl || null,
    contentType,
    source: publicUrl ? "r2" : "no_r2",
    macOk: dec.macOk,
  };
}

module.exports = { resolveAndStoreMedia };