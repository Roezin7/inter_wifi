function norm(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");
}

function safeText(x) {
  if (x === null || x === undefined) return "";
  if (typeof x === "string") return x;
  try {
    return JSON.stringify(x);
  } catch {
    return String(x);
  }
}

function extractFirstNumber(text) {
  const m = String(text || "").match(/(\d+([.,]\d+)?)/);
  return m ? m[1] : null;
}

module.exports = { norm, safeText, extractFirstNumber };