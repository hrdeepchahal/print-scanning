const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const scanRoutes = require("./routes/scan.routes");
const scanSessionRoutes = require("./routes/scanSession.routes");
const docsRoutes = require("./routes/docs.routes");
const printRoutes = require("./routes/print.routes");
const documentationRoutes = require("./routes/documentation.routes");
const logger = require("./utils/logger");

const app = express();

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// HTTP request logging via morgan -> winston
app.use(
  morgan("combined", {
    stream: { write: (message) => logger.http(message.trim()) },
  })
);

app.use("/api", scanRoutes);
app.use("/api", scanSessionRoutes);
app.use("/api", docsRoutes);
app.use("/api", printRoutes);
app.use("/", documentationRoutes);

// Global error handler — no unhandled crashes
app.use((err, req, res, next) => {
  logger.error(`Unhandled error: ${err.message}`, { stack: err.stack });
  res.status(500).json({ success: false, message: "Internal server error", error: err.message });
});

module.exports = app;
