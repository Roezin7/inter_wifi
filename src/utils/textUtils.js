function norm(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")     // quita acentos
    .replace(/[^a-z0-9\s]/g, " ")        // quita símbolos raros
    .replace(/\s+/g, " ")
    .trim();
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