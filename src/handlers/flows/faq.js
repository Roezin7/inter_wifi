// src/handlers/flows/faq.js
const {
  answerKnowledgeQuestion,
  getKnowledgeByTopic,
  norm,
  canonicalIntent,
  formatKnowledgeReply,
} = require("../../services/faqService");
const { pick } = require("../../utils/replies");

function pickText(options, seed, fallback = "") {
  return String(pick(options, seed) || fallback || options[0] || "").trim();
}

function faqMenu(seed = "") {
  return [
    pickText(
      [
        "Claro 😊",
        "Con gusto 😊",
        "Claro que sí ✨",
      ],
      `faq_intro:${seed}`
    ),
    (
      pickText(
        [
          "Puedo ayudarte con esto:",
          "Te comparto estas opciones:",
          "Puedes preguntarme sobre esto:",
        ],
        `faq_options:${seed}`
      ) +
      "\n\n" +
      "*1*. Horarios\n" +
      "*2*. Ubicación\n" +
      "*3*. Formas de pago\n" +
      "*4*. Planes y precios\n\n" +
      pickText(
        [
          "Si prefieres, solo dime tu duda.",
          "Si quieres, también puedes escribirme tu pregunta.",
          "Si te queda más fácil, solo dime qué necesitas saber.",
        ],
        `faq_prompt:${seed}`
      )
    ),
  ];
}

function footerShort(seed = "") {
  return (
    "\n\n" +
    pickText(
      [
        "Si necesitas algo más, aquí te apoyo 😊",
        "Si te ayudo con algo más, aquí sigo 😊",
        "Si quieres revisar otra cosa, con gusto te apoyo ✨",
      ],
      `faq_footer:${seed}`
    )
  );
}

function intro(seed = "") {
  return faqMenu(seed);
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

function appendFooter(out, footer) {
  if (!footer) return out;

  if (Array.isArray(out)) {
    const items = out.filter(Boolean);
    if (!items.length) return footer.trim();
    items[items.length - 1] = `${items[items.length - 1]}${footer}`;
    return items;
  }

  return `${out}${footer}`;
}

async function sendTopicAnswer(topic, send, updateSession, data, seed = "") {
  const entry = await getKnowledgeByTopic(topic);
  if (!entry?.answer) return false;

  await updateSession({ step: 2, data: { ...data, faq_entered: true, last: topic } });
  await send(
    appendFooter(
      formatKnowledgeReply({ ...entry, answer: wrapPro(entry.answer, entry.category) }),
      footerShort(seed)
    )
  );
  return true;
}

async function handle({ session, inbound, send, updateSession }) {
  const step = Number(session.step || 1);
  const data = session.data || {};
  const text = String(inbound.text || "").trim();
  const seed = [session.phone_e164 || inbound.phoneE164 || "", text || "faq"].join("|");

  if (!text || isFaqMenuWord(text)) {
    if (step !== 1 || !data.faq_entered) {
      await updateSession({ step: 1, data: { ...data, faq_entered: true } });
    }
    await send(faqMenu(seed));
    return;
  }

  const choice = parseFaqChoice(text);
  if (choice) {
    const sent = await sendTopicAnswer(choice, send, updateSession, data, `${seed}:choice`);
    if (sent) return;
  }

  const canon = canonicalIntent(text);
  if (canon) {
    const sent = await sendTopicAnswer(canon, send, updateSession, data, `${seed}:canon`);
    if (sent) return;
  }

  const answer = await answerKnowledgeQuestion(text);
  if (answer?.answer) {
    await updateSession({
      step: 2,
      data: { ...data, faq_entered: true, last: answer.topic || answer.group_key || answer.id || null },
    });
    await send(
      appendFooter(
        formatKnowledgeReply({ ...answer, answer: wrapPro(answer.answer, answer.category) }),
        footerShort(`${seed}:answer`)
      )
    );
    return;
  }

  await updateSession({ step: 2, data: { ...data, faq_entered: true, last: "no_match" } });
  await send(
    "Puedo ayudarte con horarios, ubicación, pagos, planes o seguimiento de reportes 😊\n\nSi quieres, solo dime qué necesitas saber."
  );
}

module.exports = { intro, handle };
