function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

const BASE_URL = mustEnv("WASENDER_BASE_URL").replace(/\/$/, "");
const TOKEN = mustEnv("WASENDER_TOKEN");

async function sendText({ toE164, text }) {
  const url = `${BASE_URL}/api/send-message`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`
    },
    body: JSON.stringify({ to: toE164, text })
  });

  const raw = await resp.text().catch(() => "");
  if (!resp.ok) throw new Error(`Wasender send-message failed: ${resp.status} ${raw}`);

  try {
    return JSON.parse(raw);
  } catch {
    return { ok: true, raw };
  }
}

module.exports = { sendText };