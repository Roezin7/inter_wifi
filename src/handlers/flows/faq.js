// src/handlers/flows/faq.js
const {
  answerKnowledgeQuestion,
  getKnowledgeByTopic,
  norm,
  canonicalIntent,
} = require("../../services/faqService");

function faqMenu() {
  return (
    "Claro, te comparto esta información:\n\n" +
    "1. Horarios\n" +
    "2. Ubicación\n" +
    "3. Formas de pago\n" +
    "4. Planes y precios\n\n" +
    "Si prefieres, solo dime tu duda."
  );
}

function footerShort() {
  return "\n\nSi necesitas algo más, aquí te apoyo.";
}

function intro() {
  return faqMenu();
}

function parseFaqChoice(text) {
  const t = norm(text);
  if (t === "1") return "horarios";
  if (t === "2") return "ubicacion";
  if (t === "3") return "pagos";
  if (t === "4") return "precios";
  return null;
}

function isFaqMenuWord(text) {
  return /^(info|informacion|información|opciones|ayuda|help)$/i.test(norm(text));
}

function fixNewlines(s) {
  return String(s || "")
    .replace(/\\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function wrapPro(rawAnswer, category) {
  const a = fixNewlines(rawAnswer);
  if (!a) return "";

  if (/^(📍|🕒|💳|💰|🧾|✅|🏦|📌|🔐|🏠)/u.test(a) || /^\*[^*]+\*/.test(a)) {
    return a;
  }

  const cat = norm(category);

  const header =
    cat === "pagos"
      ? "💳 *Pagos*\n\n"
      : cat === "precios"
      ? "💰 *Planes y precios*\n\n"
      : "📌 *Información*\n\n";

  return header + a;
}

async function sendTopicAnswer(topic, send, updateSession, data) {
  const entry = await getKnowledgeByTopic(topic);
  if (!entry?.answer) return false;

  await updateSession({ step: 2, data: { ...data, faq_entered: true, last: topic } });
  await send(wrapPro(entry.answer, entry.category) + footerShort());
  return true;
}

async function handle({ session, inbound, send, updateSession }) {
  const step = Number(session.step || 1);
  const data = session.data || {};
  const text = String(inbound.text || "").trim();

  if (!text || isFaqMenuWord(text)) {
    if (step !== 1 || !data.faq_entered) {
      await updateSession({ step: 1, data: { ...data, faq_entered: true } });
    }
    await send(faqMenu());
    return;
  }

  const choice = parseFaqChoice(text);
  if (choice) {
    const sent = await sendTopicAnswer(choice, send, updateSession, data);
    if (sent) return;
  }

  const canon = canonicalIntent(text);
  if (canon) {
    const sent = await sendTopicAnswer(canon, send, updateSession, data);
    if (sent) return;
  }

  const answer = await answerKnowledgeQuestion(text);
  if (answer?.answer) {
    await updateSession({
      step: 2,
      data: { ...data, faq_entered: true, last: answer.topic || answer.group_key || answer.id || null },
    });
    await send(wrapPro(answer.answer, answer.category) + footerShort());
    return;
  }

  await updateSession({ step: 2, data: { ...data, faq_entered: true, last: "no_match" } });
  await send(
    "Puedo ayudarte con horarios, ubicación, pagos, planes o seguimiento de reportes. Si quieres, escribe tu pregunta o pon *inicio* para volver al menú principal."
  );
}

module.exports = { intro, handle };
