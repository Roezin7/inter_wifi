function normalizeToE164(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;

  const cleaned = s.replace(/^whatsapp:/i, "").trim();
  const just = cleaned.replace(/[^\d+]/g, "");
  if (!just) return null;

  if (just.startsWith("+")) return just;
  return `+${just}`;
}

module.exports = { normalizeToE164 };