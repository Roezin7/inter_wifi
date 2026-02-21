// src/utils/greetings.js

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s]/gu, "") // quita signos/emoji
    .replace(/\s+/g, " ");
}

/**
 * true si el mensaje es solo saludo (o saludo + 1-2 palabras tipo "buenas", "qué tal")
 * y NO contiene intención de contratar/pagar/falla/etc.
 */
function isGreetingOnly(text) {
  const t = norm(text);
  if (!t) return false;

  // frena si trae keywords de negocio
  const hasBusiness =
    /(contrat|instal|servicio|internet|plan|paquete|precio|costo|pago|pagu|deposit|transfer|comprobante|ticket|falla|sin internet|no hay internet|lento|intermit|soporte|reporte|ubic|direccion|horario)/i.test(
      t
    );
  if (hasBusiness) return false;

  // saludos comunes (MX)
  const greetRe =
    /^(hola|hol|hey|buenas|buenos dias|buen dia|buen día|buenas tardes|buenas noches|que tal|q tal|qué tal|ola|hello|hi|buenas buen as)$/i;

  if (greetRe.test(t)) return true;

  // casos tipo "hola!" "hola bro" "hey buenas"
  const words = t.split(" ").filter(Boolean);
  if (words.length <= 3) {
    const joined = words.join(" ");
    if (
      /^(hola|hey|hi|hello|buenas|ola)$/.test(words[0]) ||
      /^(buenos|buenas)$/.test(words[0]) ||
      /^(que|qué)$/.test(words[0])
    ) {
      // acepta "hola arturo" "hola bro" "buenas noches"
      if (
        /^(hola|hey|hi|hello|ola|buenas|buenos|que|qué)$/.test(words[0]) ||
        /^(buenos dias|buen dia|buen día|buenas tardes|buenas noches|que tal|qué tal)$/.test(joined)
      ) {
        return true;
      }
    }
  }

  return false;
}

module.exports = { isGreetingOnly };