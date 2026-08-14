require("dotenv").config();
const app = require("./src/app");
const logger = require("./src/utils/logger");
const { closeBrowser } = require("./src/services/printService");

const PORT = process.env.PORT || 4545;

app.listen(PORT, () => {
  logger.info(`Print Scanning Local Service running on port ${PORT}`);
  logger.info(`─────────────────────────────────────────────`);
  logger.info(`  Docs:       http://localhost:${PORT}/`);
  logger.info(`  Health:     http://localhost:${PORT}/api/health`);
  logger.info(`  Scan:       http://localhost:${PORT}/api/scan`);
  logger.info(`  Print:      http://localhost:${PORT}/api/print`);
  logger.info(`  Printers:   http://localhost:${PORT}/api/printers`);
  logger.info(`─────────────────────────────────────────────`);
});

async function shutdown() {
  await closeBrowser();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
