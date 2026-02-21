// src/services/mediaService.js
const axios = require("axios");

// Idealmente apunta a tu storage (S3/R2/Cloudinary)
// Aquí lo dejo como stub: si no configuras, simplemente no convierte nada.
const ENABLE_MEDIA_STORAGE = String(process.env.ENABLE_MEDIA_STORAGE || "false") === "true";

/**
 * Ajusta este downloader a tu proveedor (Wasender).
 * La idea:
 *  - Si tienes mediaId, llamas el endpoint del proveedor para descargar binario
 *  - Regresas { buffer, contentType, filename }
 */
async function downloadFromProvider({ mediaId, mime }) {
  // ⚠️ TODO: AJUSTAR a tu API real (Wasender)
  // Ejemplo hipotético:
  // GET `${WASENDER_BASE}/media/${mediaId}` con Authorization Bearer
  //
  // Si tu proveedor NO da mediaId, no podrás descargar aquí.

  const WASENDER_BASE = process.env.WASENDER_BASE_URL;
  const WASENDER_TOKEN = process.env.WASENDER_TOKEN;

  if (!WASENDER_BASE || !WASENDER_TOKEN) {
    throw new Error("WASENDER_BASE_URL / WASENDER_TOKEN missing for media download");
  }
  if (!mediaId) {
    throw new Error("mediaId missing (cannot download media)");
  }

  // 👇 Ajusta endpoint real de descarga
  const url = `${WASENDER_BASE}/media/${encodeURIComponent(mediaId)}`;

  const res = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 30000,
    headers: {
      Authorization: `Bearer ${WASENDER_TOKEN}`,
    },
  });

  const contentType = res.headers["content-type"] || mime || "application/octet-stream";
  const buffer = Buffer.from(res.data);

  // genera filename simple
  const ext =
    contentType.includes("pdf") ? "pdf" :
    contentType.includes("jpeg") ? "jpg" :
    contentType.includes("png") ? "png" :
    "bin";

  return { buffer, contentType, filename: `receipt_${Date.now()}.${ext}` };
}

/**
 * Sube a tu storage y regresa un URL público.
 * Aquí lo dejo como stub: tú lo conectas a S3/R2/Cloudinary.
 */
async function uploadToStorage({ buffer, contentType, filename }) {
  // ⚠️ TODO: implementar con tu storage real.
  // Recomendación rápida:
  // - Cloudflare R2 + public bucket, o
  // - S3 + CloudFront, o
  // - Cloudinary (si quieres fácil)

  // Por ahora, devuelve null para no romper el flujo.
  return null;
}

/**
 * Intento “best-effort”:
 * - Si no hay storage habilitado -> regresa null
 * - Si hay mediaId -> descarga binario -> sube a storage -> regresa publicUrl
 */
async function resolveAndStoreMedia({ providerUrl, mediaId, mime, phoneE164, kind }) {
  try {
    if (!ENABLE_MEDIA_STORAGE) return null;

    // Si ya no es .enc, probablemente ya es usable:
    if (providerUrl && !String(providerUrl).includes(".enc")) {
      return { publicUrl: providerUrl };
    }

    // Si no hay mediaId no podemos descargar confiable
    if (!mediaId) return null;

    const file = await downloadFromProvider({ mediaId, mime });
    const publicUrl = await uploadToStorage(file);

    if (!publicUrl) return null;

    return { publicUrl };
  } catch (e) {
    // No rompemos el flujo de pago por un problema de storage
    return null;
  }
}

module.exports = { resolveAndStoreMedia };