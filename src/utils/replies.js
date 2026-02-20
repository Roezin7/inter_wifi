// src/utils/replies.js
function pick(arr, seed = "") {
  if (!arr || arr.length === 0) return "";
  let h = 0;
  const s = String(seed || "");
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return arr[h % arr.length];
}

const templates = {
  welcome: [
    (name) => `¡Hola${name ? ` ${name}` : ""}! 👋 Soy del equipo de InterWIFI.\n¿En qué te puedo ayudar hoy: contratar, falla, pago o info?`,
    (name) => `¡Hola${name ? ` ${name}` : ""}! 👋\nDime si es por contratación, falla, pago o info (horarios/ubicación).`,
    (name) => `¡Hola${name ? ` ${name}` : ""}! 👋 Soy InterWIFI.\n¿Qué necesitas hoy? Puedes escribir: “contratar”, “falla”, “pago” o “horarios”.`,
  ],

  contrato_intro: [
    () => `Perfecto 🙌 Para revisar cobertura, ¿me dices tu colonia y calle con número?\nEjemplo: “Centro, Hidalgo 311”.`,
    () => `Va, te apoyo con la contratación. ¿En qué colonia estás y cuál es tu calle y número?`,
    () => `Excelente. Primero confirmo cobertura: ¿me compartes colonia + calle + número?`,
  ],

  ask_colonia_more_detail: [
    () => `Gracias. ¿Me dices la colonia también? Con colonia + calle + número lo reviso rápido.`,
    () => `¿En qué colonia queda? Si me pones “colonia, calle y número” te confirmo cobertura en corto.`,
    () => `Perfecto. Solo me falta la colonia 😊 ¿Cuál es?`,
  ],

  confirm_colonia: [
    (col) => `Perfecto, entonces estás en *${col}*. ¿Correcto?`,
    (col) => `Entendido: *${col}*. ¿Sí es esa colonia?`,
    (col) => `Va. Tengo *${col}* — ¿me confirmas que es correcto?`,
  ],
};

module.exports = { templates, pick };