// src/services/imageQualityService.js
const sharp = require("sharp");

/**
 * Score rápido y barato:
 * - dims (w/h)
 * - fileSize
 * - brightness promedio
 * - blur score (varianza Laplacian aproximada)
 *
 * Nota:
 * WhatsApp comprime. Por eso usamos thresholds realistas.
 */

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

// Laplacian variance quick-ish (sin OpenCV):
// 1) grayscale
// 2) resize pequeño (p.ej. 256px) para abaratar
// 3) conv kernel Laplacian
// 4) varianza del resultado
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

  // varianza
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
  // grayscale raw; brightness promedio 0..255
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
 * @param {Buffer} buf - bytes ya decodificados (jpeg/png)
 * @param {object} opts
 */
async function evaluateIneQuality(buf, opts = {}) {
  const {
    minShortSide = 850,       // INE legible en WA normalmente >= 850px lado corto
    minBytes = 110_000,       // evita ultra comprimidas
    minBrightness = 55,       // muy oscuro < ~55
    maxBrightness = 215,      // muy quemado > ~215
    minSharpnessVar = 55,     // blur: var baja; ajustable
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
  const longSide = Math.max(width, height);

  // reglas duras
  if (bytes < minBytes) {
    return {
      ok: false,
      reason: "too_small_file",
      details: { bytes, minBytes, width, height },
    };
  }

  if (shortSide < minShortSide) {
    return {
      ok: false,
      reason: "low_resolution",
      details: { width, height, shortSide, minShortSide },
    };
  }

  // métricas
  const brightness = await avgBrightness(img);
  if (brightness < minBrightness) {
    return {
      ok: false,
      reason: "too_dark",
      details: { brightness },
    };
  }
  if (brightness > maxBrightness) {
    return {
      ok: false,
      reason: "too_bright",
      details: { brightness },
    };
  }

  const sharpVar = await laplacianVariance(img);
  if (sharpVar < minSharpnessVar) {
    return {
      ok: false,
      reason: "blurry",
      details: { sharpVar },
    };
  }

  // “score” opcional (0..100) por si quieres guardar y auditar
  const resScore = clamp((shortSide / minShortSide) * 35, 0, 35);
  const sizeScore = clamp((bytes / minBytes) * 20, 0, 20);
  const sharpScore = clamp((sharpVar / minSharpnessVar) * 30, 0, 30);
  const brightScore = 15; // ya pasó umbrales
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
      longSide,
      format: meta.format || null,
    },
  };
}

module.exports = { evaluateIneQuality };