require("dotenv").config();
const app = require("./src/app");
const logger = require("./src/utils/logger");
const { closeBrowser } = require("./src/services/printService");
const { getAllCapabilities } = require("./src/services/capabilityService");
const { isSwaggerEnabled } = require("./src/swagger/swagger.config");

const PORT = process.env.PORT || 4545;

app.listen(PORT, () => {
  logger.info(`Print Scanning Local Service running on port ${PORT}`);
  logger.info(`─────────────────────────────────────────────`);
  logger.info(`  Docs:       http://localhost:${PORT}/`);
  logger.info(`  Health:     http://localhost:${PORT}/api/health`);
  logger.info(`  Scan:       http://localhost:${PORT}/api/scan`);
  logger.info(`  Print:      http://localhost:${PORT}/api/print`);
  logger.info(`  Printers:   http://localhost:${PORT}/api/printers`);
  logger.info(`  Capabilities: http://localhost:${PORT}/api/capabilities`);
  if (isSwaggerEnabled(process.env.NODE_ENV, process.env.SWAGGER_ENABLED)) {
    logger.info(`  Swagger UI: http://localhost:${PORT}/api-docs`);
  }
  logger.info(`─────────────────────────────────────────────`);
  logCapabilities();
});

async function logCapabilities() {
  try {
    const { printer, scanner } = await getAllCapabilities();

    if (printer.duplexSupported === null) {
      logger.info("Duplex printing: unknown (not checkable on this platform)");
    } else if (printer.duplexSupported) {
      logger.info("Duplex printing: supported");
    } else {
      logger.warn(`Duplex printing: NOT supported — "${printer.name || "(default)"}" has no duplex option in its CUPS driver`);
    }

    if (scanner.adfSupported === null) {
      logger.info("ADF (bulk scanning): unknown (not checkable on this platform)");
    } else if (scanner.adfSupported) {
      logger.info("ADF (bulk scanning): supported");
    } else {
      logger.warn(`ADF (bulk scanning): NOT supported — "${scanner.device || "(default)"}" has no ADF source (flatbed only)`);
    }
  } catch (err) {
    logger.warn(`Startup capability check failed: ${err.message}`);
  }
}

async function shutdown() {
  await closeBrowser();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
