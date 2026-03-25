const DEBUG_ENABLED = /^(1|true|debug)$/i.test(
  String(process.env.LOG_LEVEL || process.env.DEBUG || "").trim()
);

const logger = {
  debug: (...args) => {
    if (DEBUG_ENABLED) console.log("[DEBUG]", ...args);
  },
  info: (...args) => console.log("[INFO]", ...args),
  warn: (...args) => console.warn("[WARN]", ...args),
  error: (...args) => console.error("[ERROR]", ...args)
};

module.exports = { logger };
