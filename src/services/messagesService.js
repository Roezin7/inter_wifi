// src/services/messagesService.js
const crypto = require("crypto");
const { query } = require("../db");

function q(client) {
  return client ? client.query.bind(client) : query;
}

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ");
}

function buildDedupeKey({ phoneE164, direction, body, media, providerMsgId, raw }) {
  // Si hay msg id del proveedor, úsalo directo (más fuerte).
  if (providerMsgId) return `pmid:${providerMsgId}`;

  // Fallback robusto: usa campos que normalmente NO cambian entre reintentos.
  // Incluye un “rawId” si viene, y timestamp si el proveedor lo manda.
  const firstUrl = media?.urls?.[0] || media?.url || null;
  const mediaCount = Array.isArray(media?.urls) ? media.urls.length : (firstUrl ? 1 : 0);

  const rawId =
    raw?.messageId ||
    raw?.id ||
    raw?.data?.id ||
    raw?.messages?.[0]?.id ||
    raw?.messages?.[0]?.key?.id ||
    null;

  const ts =
    raw?.timestamp ||
    raw?.messageTimestamp ||
    raw?.messages?.[0]?.messageTimestamp ||
    raw?.messages?.[0]?.timestamp ||
    null;

  const payload = {
    phoneE164,
    direction,
    body: norm(body),
    firstUrl,
    mediaCount,
    rawId,
    ts
  };

  const hash = crypto
    .createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");

  return `hash:${hash}`;
}

async function insertWaMessage({
  sessionId,
  phoneE164,
  direction,
  body,
  media,
  raw,
  providerMsgId
}) {
  const provider_dedupe_key = buildDedupeKey({
    phoneE164,
    direction,
    body,
    media,
    providerMsgId,
    raw
  });

  const { rows } = await query(
    `
    INSERT INTO wa_messages
      (session_id, phone_e164, direction, body, media, raw, provider_msg_id, provider_dedupe_key)
    VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (provider_dedupe_key) DO NOTHING
    RETURNING id, session_id, phone_e164, direction, provider_msg_id, provider_dedupe_key, created_at
    `,
    [
      sessionId || null,
      phoneE164,
      direction,
      body || "",
      media || null,
      raw || null,
      providerMsgId || null,
      provider_dedupe_key
    ]
  );

  return rows[0] || null;
}

async function getOutboundPresentationState(
  phoneE164,
  { greetingCooldownMin = 180, imageCooldownMin = 720 } = {},
  client = null
) {
  const run = q(client);
  const safeGreetingCooldownMin = Math.max(0, Number(greetingCooldownMin || 0));
  const safeImageCooldownMin = Math.max(0, Number(imageCooldownMin || 0));

  const { rows } = await run(
    `
    select
      exists(
        select 1
        from wa_messages
        where phone_e164 = $1
          and direction = 'OUT'
        limit 1
      ) as has_outbound_history,
      exists(
        select 1
        from wa_messages
        where phone_e164 = $1
          and direction = 'OUT'
          and coalesce(raw->>'kind', '') in ('welcome_greeting', 'menu_no_session', 'menu_low_conf')
          and created_at >= now() - ($2::int * interval '1 minute')
        limit 1
      ) as greeted_recently,
      exists(
        select 1
        from wa_messages
        where phone_e164 = $1
          and direction = 'OUT'
          and coalesce(raw->>'kind', '') = 'welcome_image'
          and created_at >= now() - ($3::int * interval '1 minute')
        limit 1
      ) as image_recently
    `,
    [phoneE164, safeGreetingCooldownMin, safeImageCooldownMin]
  );

  return (
    rows[0] || {
      has_outbound_history: false,
      greeted_recently: false,
      image_recently: false,
    }
  );
}

module.exports = { insertWaMessage, getOutboundPresentationState };
