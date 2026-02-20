require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");

const { runMigrations } = require("./src/db");
const wasenderRouter = require("./src/routes/wasender");
const waRouter = require("./src/routes/wa");
const { logger } = require("./src/utils/logger");

const app = express();

// Trust proxy (Render)
app.set("trust proxy", 1);

// Middlewares
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: "5mb" }));
app.use(morgan("combined"));

// Rate limit (anti spam)
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: true,
    legacyHeaders: false
  })
);

app.get("/health", (req, res) => res.json({ ok: true }));

// Routes
app.use("/wasender", wasenderRouter); // inbound webhook
app.use("/wa", waRouter); // outbound manual endpoint (opcional)

// Start
async function start() {
  try {
    await runMigrations();

    const port = Number(process.env.PORT || 3000);
    app.listen(port, () => logger.info(`Server running on port ${port}`));
  } catch (e) {
    logger.error("Fatal start error", e);
    process.exit(1);
  }
}

start();