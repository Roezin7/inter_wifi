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
  return "bin";
}

function sha1(s) {
  return crypto.createHash("sha1").update(String(s || "")).digest("hex").slice(0, 12);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function looksEnc(url) {
  return /\.enc(\?|$)/i.test(String(url || ""));
}

// =======================
// WhatsApp media decrypt
// =======================
function inferWaMediaType({ kind, mime }) {
  const k = String(kind || "").toLowerCase();
  if (k === "image") return "image";
  if (k === "video") return "video";
  if (k === "audio") return "audio";
  if (k === "document") return "document";
  if (k === "sticker") return "image";

  const m = String(mime || "").toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  return "document";
}

function waInfoString(mediaType) {
  switch (mediaType) {
    case "image":
      return "WhatsApp Image Keys";
    case "video":
      return "WhatsApp Video Keys";
    case "audio":
      return "WhatsApp Audio Keys";
    default:
      return "WhatsApp Document Keys";
  }
}

/**
 * Deriva iv/cipherKey/macKey a partir de mediaKey (base64)
 * HKDF-SHA256 con salt=0x00.. y info "WhatsApp <Type> Keys"
 */
function deriveWaKeys(mediaKeyB64, mediaType) {
  const mediaKey = Buffer.from(String(mediaKeyB64 || ""), "base64");
  if (!mediaKey.length) throw new Error("deriveWaKeys: missing mediaKey");

  const info = Buffer.from(waInfoString(mediaType), "utf-8");
  const salt = Buffer.alloc(32, 0);

  // WhatsApp requiere 112 bytes de output
  const expanded = crypto.hkdfSync("sha256", mediaKey, salt, info, 112);

  const iv = expanded.subarray(0, 16);
  const cipherKey = expanded.subarray(16, 48); // 32 bytes
  const macKey = expanded.subarray(48, 80); // 32 bytes
  // const refKey = expanded.subarray(80, 112); // no necesario

  return { iv, cipherKey, macKey };
}

/**
 * Descarga binario (sin auth) desde la URL mmg.whatsapp.net
 * con reintentos ligeros.
 */
async function downloadBinary(url, { retries = 2 } = {}) {
  const u = String(url || "");
  if (!u) throw new Error("downloadBinary: missing url");

  let lastErr = null;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetchFn(u, {
        method: "GET",
        // algunos edges se ponen mamones sin UA
        headers: { "User-Agent": "Mozilla/5.0" },
      });

      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`downloadBinary failed: ${res.status} ${txt.slice(0, 200)}`);
      }

      const contentType = res.headers.get("content-type") || "application/octet-stream";
      const buf = Buffer.from(await res.arrayBuffer());
      return { buf, contentType };
    } catch (e) {
      lastErr = e;
      if (i < retries) await sleep(250 * (i + 1));
    }
  }
  throw lastErr || new Error("downloadBinary failed");
}

/**
 * WhatsApp .enc format:
 * - body: ciphertext
 * - tail: 10 bytes MAC (truncated HMAC-SHA256)
 *
 * MAC = first10(HMAC(macKey, iv + ciphertext))
 * PLAINTEXT = AES-256-CBC(cipherKey, iv) decrypt(ciphertext)
 */
function decryptWhatsAppEnc({ encBuf, mediaKeyB64, mime, kind }) {
  if (!Buffer.isBuffer(encBuf) || !encBuf.length) throw new Error("decrypt: empty encBuf");

  const mediaType = inferWaMediaType({ kind, mime });
  const { iv, cipherKey, macKey } = deriveWaKeys(mediaKeyB64, mediaType);

  // últimos 10 bytes son MAC
  if (encBuf.length <= 10) throw new Error("decrypt: encBuf too small");
  const fileMac = encBuf.subarray(encBuf.length - 10);
  const ciphertext = encBuf.subarray(0, encBuf.length - 10);

  // validar MAC (best-effort; si falla, no vale la pena seguir)
  const hmac = crypto.createHmac("sha256", macKey).update(Buffer.concat([iv, ciphertext])).digest();
  const mac10 = hmac.subarray(0, 10);

  // timing safe compare
  if (fileMac.length !== mac10.length || !crypto.timingSafeEqual(fileMac, mac10)) {
    throw new Error("decrypt: mac_mismatch");
  }

  const decipher = crypto.createDecipheriv("aes-256-cbc", cipherKey, iv);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext;
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
 * Resuelve la url pública del media:
 * - Si ya NO es .enc => se regresa tal cual.
 * - Si es .enc => descarga, desencripta con mediaKey, sube a R2 y regresa URL pública.
 */
async function resolveAndStoreMedia({
  providerUrl,
  mediaKey,
  mime,
  phoneE164,
  kind,
  folder = "uploads",
  filenamePrefix = "media",
}) {
  const url = String(providerUrl || "").trim();
  const isEnc = looksEnc(url);

  if (url && !isEnc) {
    return { publicUrl: url, contentType: mime || null, source: "as_is" };
  }

  if (!url) {
    return { publicUrl: null, contentType: mime || null, source: "no_url" };
  }

  if (!mediaKey) {
    // sin mediaKey NO puedes desencriptar WhatsApp
    return { publicUrl: null, contentType: mime || null, source: "no_media_key" };
  }

  let dl;
  try {
    dl = await downloadBinary(url, { retries: 2 });
  } catch (e) {
    return { publicUrl: null, contentType: mime || null, source: "download_failed", reason: e?.message };
  }

  const contentType = mime || dl.contentType || "application/octet-stream";

  let plain;
  try {
    plain = decryptWhatsAppEnc({
      encBuf: dl.buf,
      mediaKeyB64: mediaKey,
      mime: contentType,
      kind,
    });
  } catch (e) {
    return {
      publicUrl: null,
      contentType,
      source: "decrypt_failed",
      reason: e?.message || "decrypt_failed",
    };
  }

  const ext = extFromMime(contentType);
  const key = [
    String(folder || "uploads").replace(/^\/+|\/+$/g, ""),
    kind || "media",
    new Date().toISOString().slice(0, 10),
    `${sha1(phoneE164)}_${sha1(url)}_${sha1(mediaKey)}_${filenamePrefix}.${ext}`,
  ].join("/");

  const publicUrl = await uploadToR2({ key, buf: plain, contentType });

  return { publicUrl: publicUrl || null, contentType, source: publicUrl ? "r2" : "no_r2" };
}

module.exports = { resolveAndStoreMedia };