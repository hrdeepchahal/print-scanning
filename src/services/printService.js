const os = require("os");
const fs = require("fs");
const path = require("path");
const util = require("util");
const exec = util.promisify(require("child_process").exec);
const { v4: uuidv4 } = require("uuid");
const logger = require("../utils/logger");

const TEMP_DIR = path.join(os.tmpdir(), "print-scanning");

const PDF_CONFIGS = {
  /* Margins come from CSS @page inside the HTML (same as browser print preview). */
  exam: {
    format: "A4",
    margin: { top: "0", right: "0", bottom: "0", left: "0" },
    printBackground: true,
    preferCSSPageSize: true,
  },
  omr: {
    format: "A4",
    margin: { top: "0", right: "0", bottom: "0", left: "0" },
    printBackground: true,
    scale: 1,
  },
};

function ensureTempDir() {
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }
}

/**
 * Convert HTML string to a PDF file using Puppeteer.
 * @param {string} html - Full HTML document string
 * @param {string} printType - "exam" or "omr"
 * @returns {Promise<string>} Path to the generated temp PDF
 */
async function convertHtmlToPdf(html, printType = "exam") {
  ensureTempDir();

  const pdfPath = path.join(TEMP_DIR, `print_${uuidv4()}.pdf`);
  const config = PDF_CONFIGS[printType] || PDF_CONFIGS.exam;

  let browser;
  try {
    const puppeteer = require("puppeteer");
    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],
    });

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0", timeout: 30000 });
    await page.pdf({ path: pdfPath, ...config });

    logger.info(`PDF generated: ${pdfPath} (type: ${printType})`);
    return pdfPath;
  } finally {
    if (browser) await browser.close();
  }
}

/**
 * Send a PDF to the OS print spooler.
 * Linux/macOS: CUPS `lp` command
 * Windows: pdf-to-printer package
 * @param {string} pdfPath - Absolute path to the PDF file
 * @param {string|null} printerName - Target printer (null = system default)
 */
async function printPdf(pdfPath, printerName) {
  const platform = os.platform();

  if (platform === "win32") {
    const pdfToPrinter = require("pdf-to-printer");
    const opts = printerName ? { printer: printerName } : {};
    await pdfToPrinter.print(pdfPath, opts);
    logger.info(`Print job sent (Windows) to ${printerName || "default printer"}`);
  } else {
    const args = printerName ? ["-d", printerName] : [];
    const cmd = `lp ${args.join(" ")} "${pdfPath}"`;
    const { stdout } = await exec(cmd);
    logger.info(`Print job sent (CUPS): ${stdout.trim()}`);
  }
}

/**
 * Remove a temporary PDF file.
 * @param {string} pdfPath
 */
function cleanupTempPdf(pdfPath) {
  try {
    if (fs.existsSync(pdfPath)) {
      fs.unlinkSync(pdfPath);
      logger.info(`Temp PDF removed: ${pdfPath}`);
    }
  } catch (err) {
    logger.warn(`Failed to clean up temp PDF ${pdfPath}: ${err.message}`);
  }
}

/**
 * Full pipeline: HTML -> PDF -> print -> cleanup.
 * @param {string} html - HTML content to print
 * @param {string} printType - "exam" or "omr"
 * @param {string|null} printerName - Target printer (null = system default)
 */
async function printFromHtml(html, printType, printerName) {
  const pdfPath = await convertHtmlToPdf(html, printType);
  try {
    await printPdf(pdfPath, printerName);
  } finally {
    cleanupTempPdf(pdfPath);
  }
}

module.exports = {
  printFromHtml,
  convertHtmlToPdf,
  printPdf,
  cleanupTempPdf,
};
