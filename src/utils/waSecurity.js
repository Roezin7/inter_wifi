function verifySecret(req) {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) return true;

  const headerName = process.env.WEBHOOK_SECRET_HEADER || "x-webhook-secret";
  const got = req.headers[headerName];
  return String(got || "") === String(secret);
}

module.exports = { verifySecret };