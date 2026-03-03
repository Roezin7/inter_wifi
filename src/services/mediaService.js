// src/services/mediaService.js
const crypto = require("crypto");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const sharp = require("sharp");

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

// ==============
// WASENDER (fallback, opcional)
// ==============
const WASENDER_BASE_URL = process.env.WASENDER_BASE_URL; // ej: https://wasenderapi.com/api
const WASENDER_API_KEY = process.env.WASENDER_API_KEY; // tu key/token

// =======================
// Utils
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

function isEncUrl(url) {
  return /\.enc(\?|$)/i.test(String(url || ""));
}

function mimeToWaMediaType(mime) {
  const m = String(mime || "").toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  // PDFs y docs
  return "document";
}

function waInfoString(mediaType) {
  // WhatsApp HKDF “info” strings (estándar)
  // Nota: en Baileys suelen ser:
  // image => "WhatsApp Image Keys"
  // video => "WhatsApp Video Keys"
  // audio => "WhatsApp Audio Keys"
  // document => "WhatsApp Document Keys"
  switch (String(mediaType || "").toLowerCase()) {
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

async function downloadByUrl(url, { headers } = {}) {
  const res = await fetchFn(url, {
    method: "GET",
    headers: headers || undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`downloadByUrl failed: ${res.status} ${text?.slice(0, 200)}`);
  }

  const contentType = res.headers.get("content-type") || "application/octet-stream";
  const buf = Buffer.from(await res.arrayBuffer());
  return { buf, contentType };
}

/**
 * ⚠️ Fallback opcional (si tu Wasender sí expone un download por mediaId)
 * Puedes ajustar endpoint a tu realidad.
 */
async function downloadFromWasender({ mediaId }) {
  if (!WASENDER_BASE_URL || !WASENDER_API_KEY) return null;
  if (!mediaId) return null;

  // AJUSTA si existe en tu Wasender real
  const url = `${String(WASENDER_BASE_URL).replace(/\/+$/, "")}/media/${encodeURIComponent(
    mediaId
  )}/download`;

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

  const base = String(R2_PUBLIC_BASE).replace(/\/+$/, "");
  return `${base}/${key}`;
}

/**
 * ==========================
 * WhatsApp .enc decrypt (Baileys-style)
 * ==========================
 * mediaKey: base64 (WhatsApp)
 * encrypted file format: [ciphertext][mac(10)]
 * mac = first 10 bytes of HMAC-SHA256(macKey, iv + ciphertext)
 * aes-256-cbc(cipherKey, iv) on ciphertext => plaintext
 */
function hkdfSha256({ ikm, info, length = 112 }) {
  // salt = 32 bytes zeros
  const salt = Buffer.alloc(32, 0);
  return crypto.hkdfSync("sha256", ikm, salt, Buffer.from(info, "utf8"), length);
}

function decryptWhatsAppEnc({ encBuf, mediaKeyB64, mediaType }) {
  if (!encBuf?.length) throw new Error("decryptWhatsAppEnc: empty encBuf");
  if (!mediaKeyB64) throw new Error("decryptWhatsAppEnc: missing mediaKey");
  const info = waInfoString(mediaType);

  let mediaKey;
  try {
    mediaKey = Buffer.from(String(mediaKeyB64), "base64");
  } catch {
    throw new Error("decryptWhatsAppEnc: invalid mediaKey base64");
  }

  const keyMaterial = hkdfSha256({ ikm: mediaKey, info, length: 112 });

  const iv = keyMaterial.subarray(0, 16);
  const cipherKey = keyMaterial.subarray(16, 48);
  const macKey = keyMaterial.subarray(48, 80);

  // last 10 bytes are mac
  if (encBuf.length <= 10) throw new Error("decryptWhatsAppEnc: too short");
  const file = encBuf.subarray(0, encBuf.length - 10);
  const mac = encBuf.subarray(encBuf.length - 10);

  // verify mac
  const hmac = crypto.createHmac("sha256", macKey).update(Buffer.concat([iv, file])).digest();
  const macExpected = hmac.subarray(0, 10);

  if (!crypto.timingSafeEqual(mac, macExpected)) {
    throw new Error("decryptWhatsAppEnc: mac check failed");
  }

  // decrypt AES-256-CBC
  const decipher = crypto.createDecipheriv("aes-256-cbc", cipherKey, iv);
  const dec1 = decipher.update(file);
  const dec2 = decipher.final();
  return Buffer.concat([dec1, dec2]);
}

// =======================
// INE Quality (pro, barato)
// =======================
function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

async function laplacianVariance(imgSharp) {
  const kernel = {
    width: 3,
    height: 3,
    kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0],
    scale: 1,
    offset: 0,
  };

  const { data } = await imgSharp
    .clone()
    .grayscale()
    .resize({ width: 256, withoutEnlargement: true })
    .convolve(kernel)
    .raw()
    .toBuffer({ resolveWithObject: true });

  const n = data.length;
  if (!n) return 0;

  let mean = 0;
  for (let i = 0; i < n; i++) mean += data[i];
  mean /= n;

  let varSum = 0;
  for (let i = 0; i < n; i++) {
    const d = data[i] - mean;
    varSum += d * d;
  }
  return varSum / n;
}

async function avgBrightness(imgSharp) {
  const { data } = await imgSharp
    .clone()
    .grayscale()
    .resize({ width: 256, withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const n = data.length;
  if (!n) return 0;

  let sum = 0;
  for (let i = 0; i < n; i++) sum += data[i];
  return sum / n;
}

/**
 * Evalúa si una foto de INE es "usable" (legible)
 * Retorna { ok, reason?, score?, details? }
 */
async function evaluateIneQuality(buf, opts = {}) {
  const {
    minShortSide = Number(process.env.INE_MIN_SHORT_SIDE || 850),
    minBytes = Number(process.env.INE_MIN_BYTES || 110_000),
    minBrightness = Number(process.env.INE_MIN_BRIGHTNESS || 55),
    maxBrightness = Number(process.env.INE_MAX_BRIGHTNESS || 215),
    minSharpnessVar = Number(process.env.INE_MIN_SHARPNESS_VAR || 55),
  } = opts;

  let img;
  try {
    img = sharp(buf, { failOnError: false });
  } catch {
    return { ok: false, reason: "invalid_image" };
  }

  const meta = await img.metadata();
  const width = Number(meta.width || 0);
  const height = Number(meta.height || 0);
  const bytes = Number(buf.length || 0);

  if (!width || !height) return { ok: false, reason: "no_dimensions" };

  const shortSide = Math.min(width, height);

  if (bytes < minBytes) {
    return { ok: false, reason: "too_small_file", details: { bytes, minBytes, width, height } };
  }

  if (shortSide < minShortSide) {
    return {
      ok: false,
      reason: "low_resolution",
      details: { width, height, shortSide, minShortSide },
    };
  }

  const brightness = await avgBrightness(img);
  if (brightness < minBrightness) return { ok: false, reason: "too_dark", details: { brightness } };
  if (brightness > maxBrightness)
    return { ok: false, reason: "too_bright", details: { brightness } };

  const sharpVar = await laplacianVariance(img);
  if (sharpVar < minSharpnessVar)
    return { ok: false, reason: "blurry", details: { sharpVar } };

  // score 0..100 (auditoría / dashboard)
  const resScore = clamp((shortSide / minShortSide) * 35, 0, 35);
  const sizeScore = clamp((bytes / minBytes) * 20, 0, 20);
  const sharpScore = clamp((sharpVar / minSharpnessVar) * 30, 0, 30);
  const brightScore = 15;
  const score = Math.round(resScore + sizeScore + sharpScore + brightScore);

  return {
    ok: true,
    score,
    details: {
      width,
      height,
      bytes,
      brightness: Math.round(brightness),
      sharpVar: Math.round(sharpVar),
      shortSide,
      format: meta.format || null,
    },
  };
}

function ineQualityMessage(reason) {
  const map = {
    low_resolution: "La foto viene con *baja resolución* y no se alcanza a leer el texto.",
    too_small_file: "La foto viene *muy comprimida* y se pierde el texto.",
    too_dark: "La foto se ve *muy oscura*.",
    too_bright: "La foto se ve *muy iluminada/quemada* (se pierde información).",
    blurry: "La foto se ve *borrosa* (sin enfoque).",
    invalid_image: "No pude leer la imagen.",
    no_dimensions: "No pude analizar la imagen.",
    mac_check_failed: "No pude procesar el archivo (integridad).",
  };

  return (
    `${map[reason] || "La foto no se ve legible."}\n\n` +
    "Para que pase a la primera:\n" +
    "• Luz directa (sin sombras)\n" +
    "• Sin reflejos\n" +
    "• Que se vean las 4 esquinas\n" +
    "• Enfocada (texto nítido)\n\n" +
    "Envíala como *foto* (no “archivo/documento”)."
  );
}

/**
 * Resuelve la url pública del media y (opcional) valida INE antes de subir.
 *
 * - Si providerUrl no es .enc:
 *    - si validateIne = true => descarga y evalúa => sube a R2
 *    - si validateIne = false => regresa as_is (o si forceUpload => sube)
 *
 * - Si providerUrl es .enc:
 *    - requiere mediaKey
 *    - descarga .enc => decrypt => (opcional eval) => sube a R2
 *
 * @returns {
 *   publicUrl, contentType, source, quality?, errorReason?
 * }
 */
async function resolveAndStoreMedia({
  providerUrl,
  mediaId,
  mime,
  mediaKey, // base64
  phoneE164,
  kind, // "contracts/ine" etc
  validateIne = false,
  forceUpload = true, // para INE normalmente true
}) {
  const url = String(providerUrl || "").trim();
  const isEnc = isEncUrl(url);

  const contentTypeHint = mime || null;
  const mediaType = mimeToWaMediaType(contentTypeHint);

  // ================
  // 1) Obtener buffer
  // ================
  let buf = null;
  let detectedContentType = contentTypeHint || "application/octet-stream";

  try {
    if (url) {
      const dl = await downloadByUrl(url);
      buf = dl.buf;
      detectedContentType = contentTypeHint || dl.contentType || detectedContentType;

      // decrypt si .enc
      if (isEnc) {
        if (!mediaKey) {
          return {
            publicUrl: null,
            contentType: detectedContentType,
            source: "missing_mediaKey",
            errorReason: "missing_mediaKey",
          };
        }

        try {
          buf = decryptWhatsAppEnc({ encBuf: buf, mediaKeyB64: mediaKey, mediaType });
          // una vez decrypt, contentType real debe ser la del mime
          detectedContentType = contentTypeHint || detectedContentType;
        } catch (e) {
          const msg = String(e?.message || e);
          return {
            publicUrl: null,
            contentType: detectedContentType,
            source: "decrypt_failed",
            errorReason: msg.includes("mac") ? "mac_check_failed" : "decrypt_failed",
          };
        }
      }
    } else {
      // sin url: fallback a mediaId si existe y tienes endpoint
      const dl = await downloadFromWasender({ mediaId });
      if (!dl?.buf?.length) {
        return { publicUrl: null, contentType: detectedContentType, source: "no_url_no_dl" };
      }
      buf = dl.buf;
      detectedContentType = contentTypeHint || dl.contentType || detectedContentType;
    }
  } catch (e) {
    return {
      publicUrl: null,
      contentType: detectedContentType,
      source: "download_failed",
      errorReason: "download_failed",
      error: String(e?.message || e).slice(0, 200),
    };
  }

  if (!buf?.length) {
    return { publicUrl: null, contentType: detectedContentType, source: "empty" };
  }

  // ======================
  // 2) Validación INE (si aplica)
  // ======================
  let quality = null;
  if (validateIne) {
    try {
      quality = await evaluateIneQuality(buf);
      if (!quality.ok) {
        return {
          publicUrl: null,
          contentType: detectedContentType,
          source: "quality_reject",
          quality,
          errorReason: quality.reason || "quality_reject",
        };
      }
    } catch (e) {
      return {
        publicUrl: null,
        contentType: detectedContentType,
        source: "quality_error",
        errorReason: "quality_error",
        error: String(e?.message || e).slice(0, 200),
      };
    }
  }

  // ======================
  // 3) Subir a R2 (si forceUpload)
  // ======================
  if (!forceUpload) {
    // si no quieres subir, regresa el url original (pero OJO: si venía .enc ya no sirve público)
    if (url && !isEnc) {
      return { publicUrl: url, contentType: detectedContentType, source: "as_is", quality };
    }
    return { publicUrl: null, contentType: detectedContentType, source: "no_upload" };
  }

  const ext = extFromMime(detectedContentType);
  const key = [
    "uploads",
    kind || "media",
    new Date().toISOString().slice(0, 10),
    `${sha1(phoneE164)}_${sha1(mediaId || url || crypto.randomUUID())}.${ext}`,
  ].join("/");

  const publicUrl = await uploadToR2({ key, buf, contentType: detectedContentType });

  return {
    publicUrl: publicUrl || null,
    contentType: detectedContentType,
    source: publicUrl ? "r2" : "no_r2",
    quality,
  };
}

module.exports = {
  resolveAndStoreMedia,
  evaluateIneQuality,
  ineQualityMessage,
};