function hasMinLen(s, n) {
  return String(s || "").trim().length >= n;
}

function looksLikePhone10MX(s) {
  const d = String(s || "").replace(/\D/g, "");
  return d.length === 10;
}

function normalizeMX10ToE164(s) {
  const d = String(s || "").replace(/\D/g, "");
  if (d.length !== 10) return null;
  return `+52${d}`;
}

function hasMediaUrls(media) {
  return !!(media && Array.isArray(media.urls) && media.urls.length > 0);
}

module.exports = { hasMinLen, looksLikePhone10MX, normalizeMX10ToE164, hasMediaUrls };