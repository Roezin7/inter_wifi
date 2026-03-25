// src/services/faqService.js
const { query } = require("../db");

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ");
}

function stemToken(t) {
  if (!t) return "";
  if (t.length > 4 && t.endsWith("s")) return t.slice(0, -1);
  return t;
}

function tokenize(s) {
  const t = norm(s);
  if (!t) return [];
  return t.split(" ").filter(Boolean).map(stemToken);
}

function jaccard(aTokens, bTokens) {
  const A = new Set(aTokens);
  const B = new Set(bTokens);
  if (!A.size || !B.size) return 0;

  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const union = A.size + B.size - inter;
  return union ? inter / union : 0;
}

function keywordHitScore(textNorm, keywords) {
  if (!keywords || !Array.isArray(keywords) || keywords.length === 0) return 0;

  let hits = 0;
  const tt = textNorm.split(" ").map(stemToken);

  for (const k of keywords) {
    const kk = norm(k);
    if (!kk) continue;

    if (textNorm.includes(kk)) {
      hits++;
      continue;
    }

    const kt = kk.split(" ").map(stemToken);
    if (kt.every((x) => tt.includes(x))) hits++;
  }

  if (hits <= 0) return 0;
  return Math.min(1, 0.70 + 0.10 * hits);
}

function canonicalIntent(textNorm) {
  const t = norm(textNorm);

  if (
    /(no han atendido|no me han atendido|no han resuelto|no me han resuelto|no se ha resuelto|no se resolvio|no se resolvió|mi reporte sigue|sigo sin respuesta|siguen sin ir|siguen sin atender|seguimiento.*reporte|estatus.*reporte|estado.*reporte|cuando vendran|cuando van a venir|aun no vienen|todavia no vienen)/i.test(
      t
    )
  ) {
    return "seguimiento_reporte";
  }

  if (/(horario|horarios|abren|cierran|atienden|atienden hoy|atienden manana|atienden mañana|sabado|sábado|domingo)/i.test(t)) {
    return "horarios";
  }

  if (
    /(pago|pagos|pagar|forma de pago|formas de pago|como pagar|cómo pagar|donde pagar|dónde pagar|deposito|depósito|transferencia|clabe|cuenta|tarjeta|oxxo|spin|azteca|comprobante|beneficiario|factura)/i.test(
      t
    )
  ) {
    return "pagos";
  }

  if (/(precio|precios|paquete|paquetes|plan|planes|cuanto cuesta|cuánto cuesta|mensualidad|instalacion|instalación)/i.test(t)) {
    return "precios";
  }

  if (/(ubicacion|ubicación|direccion|dirección|donde estan|donde se ubican|sucursal|como llego|cómo llego|mapa)/i.test(t)) {
    return "ubicacion";
  }

  return null;
}

function readEnv(name, fallback = "") {
  return String(process.env[name] || fallback)
    .replace(/\\n/g, "\n")
    .trim();
}

function joinBlocks(blocks) {
  return blocks.filter(Boolean).join("\n");
}

function buildHoursAnswer() {
  return readEnv(
    "INTERWIFI_HOURS",
    "🕒 *Horario de atención y pago en oficina*\n\n*Lunes, martes, miércoles, viernes y sábado*\n• 9:00 a.m. – 2:30 p.m.\n• 4:30 p.m. – 8:15 p.m.\n\n*Jueves y domingo*\n• 9:00 a.m. – 2:30 p.m.\n\nSi necesitas apoyo, escríbenos por aquí y con gusto te atendemos 😊"
  );
}

function buildLocationAnswer() {
  return readEnv(
    "INTERWIFI_ADDRESS",
    "📍 *Ubicación de InterWIFI*\n\nNos encontramos en:\n• Hidalgo No. 311\n• Col. Centro\n• Encarnación de Díaz, Jalisco\n\nSi quieres, dime tu *colonia* y te confirmo la cobertura en tu zona ✅"
  );
}

function buildPaymentsSummaryAnswer() {
  return readEnv(
    "INTERWIFI_PAYMENT_METHODS",
    "💳 *Formas de pago*\n\n*Pago en oficina:* efectivo, tarjeta o transferencia.\n\n*OXXO (Spin by OXXO):*\n• 4217 4700 8389 9167\n\n*Banco Azteca (Transferencia / Débito):*\n• 5512 3823 4249 4848\n\n*Beneficiario:* Alejandro Martín Cornejo\n\n🧾 *Si requieres factura:* se paga a esta cuenta BANORTE:\n• *Interpc* (Mayra Selene Montoya Chávez)\n• Cuenta: 1149553077\n• CLABE: 072349011495530779\n• RFC: MOCM840902JN3\n\n✅ Si pagas con transferencia/tarjeta, envía tu *comprobante por este WhatsApp* para registrarlo."
  );
}

function buildPaymentDatesAnswer() {
  return readEnv(
    "INTERWIFI_PAYMENT_DATES",
    "🗓️ *Fechas de pago*\n\nEl pago se realiza *del día 1 al 10 de cada mes*.\n\nSi pagas fuera de ese rango, avísanos por aquí y lo revisamos ✅"
  );
}

function buildOfficePaymentAnswer() {
  return readEnv(
    "INTERWIFI_OFFICE_PAYMENT",
    "💳 *Pago en oficina*\n\nEn oficina puedes pagar con:\n• Efectivo\n• Tarjeta *crédito/débito*\n\nSi pagas en oficina, igual puedes enviarnos el comprobante por este chat para registrarlo."
  );
}

function buildTransferPaymentAnswer() {
  return readEnv(
    "INTERWIFI_TRANSFER_DETAILS",
    "🏦 *Opciones para pagar*\n\nPuedes pagar por:\n• *OXXO (Spin by OXXO):* 4217 4700 8389 9167\n• *Banco Azteca (Transferencia / Débito):* 5512 3823 4249 4848\n\n*Beneficiario:* Alejandro Martín Cornejo\n\nAl terminar, envía el *comprobante* por este chat (foto o captura) para registrarlo ✅"
  );
}

function buildPostPaymentAnswer() {
  return readEnv(
    "INTERWIFI_AFTER_PAYMENT",
    "🧾 *Después de pagar*\n\nEnvíanos el *comprobante* por este mismo WhatsApp:\n• Foto, captura o PDF\n\nSin comprobante no podemos registrar el pago.\nSi gustas, también puedes escribir *registrar pago* para iniciar el proceso automático ✅"
  );
}

function buildReceiptWhatsappAnswer() {
  return readEnv(
    "INTERWIFI_RECEIPT_WHATSAPP",
    "✅ *Aquí mismo*\n\nEnvíalo por este chat (foto/captura/PDF) y lo registramos.\n\nSi quieres hacerlo en automático, escribe *registrar pago* y te guío paso a paso."
  );
}

function buildPlansAnswer() {
  return readEnv(
    "INTERWIFI_PLANS",
    "💰 *Paquete de internet (Encarnación de Díaz)*\n_Sin contrato forzoso • No necesitas línea telefónica_\n\n*Instalación:* $1,600\n*Mensualidad:* $300\n\n*Incluye:*\n• Router inalámbrico\n• Primer mensualidad\n\n*Características:*\n• *Velocidad:* 10MB\n• Hasta 4 dispositivos\n• Navegación ilimitada\n\n*Requisitos:*\n• INE\n• Comprobante de domicilio\n\n📌 *Importante:* En comunidades aledañas el precio puede variar."
  );
}

function buildReportFollowUpAnswer() {
  return readEnv(
    "INTERWIFI_REPORT_FOLLOWUP",
    "Entiendo la molestia. No hace falta levantar otro reporte por el mismo caso. En cuanto llegue tu turno, nos vamos a comunicar contigo para darte seguimiento."
  );
}

function faqIdentity(entry) {
  return [
    norm(entry.question),
    norm(entry.category),
    norm(entry.kind),
    norm(entry.group_key),
  ].join("|");
}

function mergeKnowledgeRows(primary, fallback) {
  const seen = new Set();
  const merged = [];

  for (const entry of [...primary, ...fallback]) {
    const key = faqIdentity(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }

  return merged;
}

function buildLocalKnowledge() {
  return [
    {
      id: "local_horarios",
      topic: "horarios",
      question: "¿Cuál es el horario de atención?",
      answer: buildHoursAnswer(),
      category: "info",
      keywords: ["horario", "horarios", "abren", "cierran", "atienden", "sabado", "domingo"],
      priority: 1000,
      kind: "DETAIL",
      group_key: "horarios",
      source: "local",
    },
    {
      id: "local_ubicacion",
      topic: "ubicacion",
      question: "¿Dónde están ubicados?",
      answer: buildLocationAnswer(),
      category: "info",
      keywords: ["ubicacion", "direccion", "donde estan", "oficina", "sucursal", "mapa"],
      priority: 1000,
      kind: "DETAIL",
      group_key: "ubicacion",
      source: "local",
    },
    {
      id: "local_pagos_summary",
      topic: "pagos",
      question: "Formas de pago (resumen)",
      answer: buildPaymentsSummaryAnswer(),
      category: "pagos",
      keywords: [
        "formas de pago",
        "pago",
        "pagos",
        "como pagar",
        "cómo pagar",
        "donde pagar",
        "dónde pagar",
        "transferencia",
        "deposito",
        "depósito",
        "clabe",
        "oxxo",
        "spin",
        "azteca",
        "banco azteca",
      ],
      priority: 1000,
      kind: "SUMMARY",
      group_key: "pagos",
      source: "local",
    },
    {
      id: "local_pago_fechas",
      topic: "pagos",
      question: "¿Qué fechas son para hacer el pago?",
      answer: buildPaymentDatesAnswer(),
      category: "pagos",
      keywords: [
        "pago",
        "pagos",
        "fechas",
        "fecha",
        "cuando pagar",
        "cuándo pagar",
        "del 1 al 10",
        "1 al 10",
        "corte",
        "vencimiento",
        "fecha limite",
        "fecha límite",
        "limite de pago",
        "límite de pago",
      ],
      priority: 950,
      kind: "DETAIL",
      group_key: "pagos",
      source: "local",
    },
    {
      id: "local_pago_oficina",
      topic: "pagos",
      question: "¿Cómo puedo pagar en oficina?",
      answer: buildOfficePaymentAnswer(),
      category: "pagos",
      keywords: [
        "pagar en oficina",
        "oficina",
        "efectivo",
        "tarjeta",
        "credito",
        "crédito",
        "debito",
        "débito",
        "terminal",
        "pago con tarjeta",
        "pago en mostrador",
      ],
      priority: 940,
      kind: "DETAIL",
      group_key: "pagos",
      source: "local",
    },
    {
      id: "local_pago_transferencia",
      topic: "pagos",
      question: "¿A dónde puedo transferir o depositar el pago?",
      answer: buildTransferPaymentAnswer(),
      category: "pagos",
      keywords: [
        "transferencia",
        "transferir",
        "deposito",
        "depósito",
        "cuenta",
        "tarjeta",
        "oxxo",
        "spin",
        "azteca",
        "banco azteca",
        "numero de tarjeta",
        "número de tarjeta",
        "beneficiario",
        "a donde deposito",
        "a dónde deposito",
        "a donde transfiero",
        "a dónde transfiero",
      ],
      priority: 930,
      kind: "DETAIL",
      group_key: "pagos",
      source: "local",
    },
    {
      id: "local_post_pago",
      topic: "pagos",
      question: "¿Qué debo hacer después de pagar con tarjeta o transferencia?",
      answer: buildPostPaymentAnswer(),
      category: "pagos",
      keywords: [
        "comprobante",
        "captura",
        "ticket",
        "transferi",
        "transferí",
        "ya pague",
        "ya pagué",
        "registrar pago",
        "confirmar pago",
        "despues de pagar",
        "después de pagar",
        "subir comprobante",
        "enviar comprobante",
      ],
      priority: 920,
      kind: "DETAIL",
      group_key: "pagos",
      source: "local",
    },
    {
      id: "local_comprobante_whatsapp",
      topic: "pagos",
      question: "¿A qué número de WhatsApp envío el comprobante?",
      answer: buildReceiptWhatsappAnswer(),
      category: "pagos",
      keywords: [
        "whatsapp",
        "numero",
        "número",
        "enviar comprobante",
        "a donde envio",
        "a dónde envío",
        "donde envio",
        "dónde envío",
        "a que numero",
        "a qué número",
        "a que whatsapp",
        "a qué whatsapp",
      ],
      priority: 910,
      kind: "DETAIL",
      group_key: "pagos",
      source: "local",
    },
    {
      id: "local_precios_summary",
      topic: "precios",
      question: "Paquete de internet (resumen)",
      answer: buildPlansAnswer(),
      category: "precios",
      keywords: [
        "precio",
        "precios",
        "paquete",
        "paquetes",
        "plan",
        "planes",
        "cuanto cuesta",
        "cuánto cuesta",
        "mensualidad",
        "instalacion",
        "instalación",
        "internet",
        "paquete de internet",
        "contratar",
      ],
      priority: 1000,
      kind: "SUMMARY",
      group_key: "precios",
      source: "local",
    },
    {
      id: "local_seguimiento_reporte",
      topic: "seguimiento_reporte",
      question: "Mi reporte no se ha resuelto",
      answer: buildReportFollowUpAnswer(),
      category: "info",
      keywords: [
        "no han atendido",
        "no me han atendido",
        "no han resuelto",
        "no me han resuelto",
        "mi reporte sigue",
        "seguimiento de reporte",
        "estado de mi reporte",
        "aun no vienen",
        "todavia no vienen",
      ],
      priority: 1200,
      kind: "DETAIL",
      group_key: "seguimiento_reporte",
      source: "local",
    },
  ];
}

function isFallbackKnowledgeAnswer(answer) {
  const t = norm(answer);
  return /(no tengo|no esta configurado|no estan configurados|no esta cargado|no estan cargados)/i.test(
    t
  );
}

function scoreFaqEntry(entry, textNorm, tokens, canon) {
  const qTokens = tokenize(entry.question);
  const jac = jaccard(tokens, qTokens);
  const key = keywordHitScore(textNorm, entry.keywords);

  let score = 0.70 * key + 0.30 * jac;

  if (canon && (entry.topic === canon || entry.group_key === canon)) {
    score = Math.min(1, score + 0.25);
  }

  if (entry.topic && norm(entry.topic) === textNorm) {
    score = Math.min(1, score + 0.30);
  }

  if (entry.source === "local" && isFallbackKnowledgeAnswer(entry.answer)) {
    score = Math.max(0, score - 0.20);
  }

  return score;
}

async function safeQueryRows(sql, params = []) {
  try {
    const { rows } = await query(sql, params);
    return rows || [];
  } catch {
    return [];
  }
}

async function getDbFaqRows() {
  const rows = await safeQueryRows(
    `
    SELECT id, question, answer, category, keywords, priority, kind, group_key
    FROM wa_faqs
    WHERE active = true
    ORDER BY priority DESC, id ASC
    `
  );

  return rows.map((row) => ({ ...row, source: "db" }));
}

async function matchFaq(userText, threshold = 0.62) {
  const textNorm = norm(userText);
  const tokens = tokenize(userText);
  if (!textNorm) return { matched: false, score: 0, faq: null };

  const canon = canonicalIntent(textNorm);
  const localEntries = buildLocalKnowledge();
  const dbEntries = await getDbFaqRows();
  const rows = mergeKnowledgeRows(dbEntries, localEntries);

  if (!rows.length) return { matched: false, score: 0, faq: null };

  let best = null;

  for (const f of rows) {
    const score = scoreFaqEntry(f, textNorm, tokens, canon);
    if (!best || score > best.score) best = { score, faq: f };
  }

  const matched = best && best.score >= threshold;

  return {
    matched,
    score: Number((best?.score || 0).toFixed(4)),
    faq: matched ? best.faq : null,
  };
}

async function getFaqById(id) {
  const rows = await safeQueryRows(
    `
    SELECT id, question, answer, category, keywords, priority, active, kind, group_key
    FROM wa_faqs
    WHERE id = $1
    LIMIT 1
    `,
    [id]
  );

  if (rows[0]) return { ...rows[0], source: "db" };

  return buildLocalKnowledge().find((entry) => String(entry.id) === String(id)) || null;
}

async function getFaqSummaryByGroup(groupKey) {
  const rows = await safeQueryRows(
    `
    SELECT id, question, answer, category, keywords, priority, kind, group_key
    FROM wa_faqs
    WHERE active = true AND kind = 'SUMMARY' AND group_key = $1
    ORDER BY priority DESC, id ASC
    LIMIT 1
    `,
    [groupKey]
  );

  if (rows[0]) return { ...rows[0], source: "db" };

  return (
    buildLocalKnowledge().find((entry) => entry.group_key === groupKey || entry.topic === groupKey) ||
    null
  );
}

async function listFaqsByCategory(category, { kind = null } = {}) {
  const local = buildLocalKnowledge().filter((entry) => entry.category === category);

  const params = [category];
  let kindSql = "";

  if (kind) {
    params.push(kind);
    kindSql = " AND kind = $2 ";
  }

  const rows = await safeQueryRows(
    `
    SELECT id, question, answer, category, keywords, priority, kind, group_key
    FROM wa_faqs
    WHERE active = true AND category = $1
    ${kindSql}
    ORDER BY priority DESC, id ASC
    `,
    params
  );

  return mergeKnowledgeRows(
    rows.map((row) => ({ ...row, source: "db" })),
    local
  );
}

async function getKnowledgeByTopic(topic) {
  const cleanTopic = norm(topic);
  if (!cleanTopic) return null;

  const matched = await matchFaq(cleanTopic, 0.35);
  if (matched?.matched && matched?.faq?.answer) return matched.faq;

  return (
    buildLocalKnowledge().find(
      (entry) => norm(entry.topic) === cleanTopic || norm(entry.group_key) === cleanTopic
    ) || null
  );
}

async function answerKnowledgeQuestion(text) {
  const matched = await matchFaq(text, Number(process.env.FAQ_MATCH_THRESHOLD || 0.62));
  return matched?.matched ? matched.faq : null;
}

module.exports = {
  norm,
  matchFaq,
  getFaqById,
  getFaqSummaryByGroup,
  listFaqsByCategory,
  canonicalIntent,
  getKnowledgeByTopic,
  answerKnowledgeQuestion,
};
