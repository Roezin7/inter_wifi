const { pick } = require("./replies");

function pickText(options, seed, fallback = "") {
  return String(pick(options, seed) || fallback || options[0] || "").trim();
}

function pairWithLead(seed, options, body) {
  return [pickText(options, seed), String(body || "").trim()].filter(Boolean);
}

function introPair(seed, body) {
  return pairWithLead(
    `${seed}:intro`,
    ["Con gusto 😊", "Claro 😊", "Perfecto ✨"],
    body
  );
}

function nextPair(seed, body) {
  return pairWithLead(
    `${seed}:next`,
    ["Perfecto 😊", "Gracias 😊", "Muy bien ✨"],
    body
  );
}

function confirmPair(seed, body) {
  return pairWithLead(
    `${seed}:confirm`,
    [
      "Solo para confirmar 😊",
      "Antes de seguir, confirmo este dato 😊",
      "Quiero confirmar esto contigo ✨",
    ],
    body
  );
}

function closePair(seed, body) {
  return pairWithLead(
    `${seed}:close`,
    ["Listo ✅", "Perfecto ✅", "Hecho ✅"],
    body
  );
}

module.exports = {
  pickText,
  introPair,
  nextPair,
  confirmPair,
  closePair,
};
