const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const scanRoutes = require("./routes/scan.routes");
const docRoutes = require("./routes/doc.routes");
const logger = require("./utils/logger");

const app = express();

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// HTTP request logging via morgan -> winston
app.use(
  morgan("combined", {
    stream: { write: (message) => logger.http(message.trim()) },
  })
);

app.use("/api", scanRoutes);
app.use("/", docRoutes);

// Global error handler — no unhandled crashes
app.use((err, req, res, next) => {
  logger.error(`Unhandled error: ${err.message}`, { stack: err.stack });
  res.status(500).json({ success: false, message: "Internal server error", error: err.message });
});

module.exports = app;
