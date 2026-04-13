const os = require("os");
const util = require("util");
const exec = util.promisify(require("child_process").exec);
const logger = require("../utils/logger");

/**
 * List available printers and identify the system default.
 *
 * Windows: uses pdf-to-printer
 * Linux/macOS: parses CUPS `lpstat -p -d` output
 *
 * @returns {Promise<{ printers: string[], default: string }>}
 */
async function listPrinters() {
  const platform = os.platform();

  if (platform === "win32") {
    return listPrintersWindows();
  }
  return listPrintersCups();
}

async function listPrintersWindows() {
  const pdfToPrinter = require("pdf-to-printer");
  const printers = await pdfToPrinter.getPrinters();
  const names = printers.map((p) => p.name);
  const defaultPrinter =
    printers.find((p) => p.isDefault)?.name || names[0] || "";

  logger.info(`Windows printers found: ${names.length}, default: ${defaultPrinter}`);
  return { printers: names, default: defaultPrinter };
}

async function listPrintersCups() {
  let printers = [];
  let defaultPrinter = "";

  try {
    const { stdout } = await exec("lpstat -p -d 2>/dev/null");
    const lines = stdout.split("\n");

    for (const line of lines) {
      const printerMatch = line.match(/^printer\s+(\S+)\s+/);
      if (printerMatch) {
        printers.push(printerMatch[1]);
      }

      const defaultMatch = line.match(/system default destination:\s*(\S+)/);
      if (defaultMatch) {
        defaultPrinter = defaultMatch[1];
      }
    }
  } catch (err) {
    logger.warn(`lpstat not available or failed: ${err.message}`);
  }

  if (!defaultPrinter && printers.length > 0) {
    defaultPrinter = printers[0];
  }

  logger.info(`CUPS printers found: ${printers.length}, default: ${defaultPrinter}`);
  return { printers, default: defaultPrinter };
}

module.exports = { listPrinters };
