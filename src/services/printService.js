const os = require("os");
const fs = require("fs");
const path = require("path");
const util = require("util");
const exec = util.promisify(require("child_process").exec);
const { v4: uuidv4 } = require("uuid");
const puppeteer = require("puppeteer");
const logger = require("../utils/logger");

const TEMP_DIR = path.join(os.tmpdir(), "print-scanning");

/*
 * Printed HTML embeds logos two ways depending on caller: OMR sheets pass the
 * branding storage's raw https:// URL, while the question-paper flow inlines it
 * as a data: URI on purpose (exam halls have no internet — see exam-ops's
 * useCenterLogoDataUri). Both must stay allowed; only file:// (local disk read
 * via untrusted HTML) is blocked. No print template uses <script>, so script
 * execution is disabled outright as defense-in-depth.
 */
const PRINT_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src https: data: blob:; font-src data:; script-src 'none'; object-src 'none'; frame-src 'none'; connect-src 'none';";

function injectPrintCsp(html) {
  const cspTag = `<meta http-equiv="Content-Security-Policy" content="${PRINT_CSP}">`;
  return /<head[^>]*>/i.test(html)
    ? html.replace(/<head[^>]*>/i, (match) => `${match}${cspTag}`)
    : `${cspTag}${html}`;
}

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

/*
 * How long / how thoroughly to wait for page.setContent() before rendering.
 * exam HTML inlines its logo as a data: URI (self-contained, see
 * useCenterLogoDataUri) so it's fully ready at domcontentloaded. omr HTML
 * references the branding storage's https:// logo URL, so it needs to wait
 * for that request to actually finish — networkidle0 (0 active connections)
 * is needlessly conservative and can stall up to 30s on any stray connection;
 * networkidle2 (<=2 active connections) is enough for a single image fetch.
 */
const CONTENT_LOAD_CONFIGS = {
  exam: { waitUntil: "domcontentloaded", timeout: 15000 },
  omr: { waitUntil: "networkidle2", timeout: 20000 },
};

function ensureTempDir() {
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }
}

let _browser = null;
let _launching = null;

/**
 * Get the shared Puppeteer browser instance, launching it on first use
 * (or after a crash) and reusing it on every subsequent call.
 */
async function getBrowser() {
  if (_browser) {
    try {
      await _browser.version();
      return _browser;
    } catch {
      _browser = null;
    }
  }

  if (_launching) return _launching;

  _launching = puppeteer
    .launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],
    })
    .then((browser) => {
      _browser = browser;
      _launching = null;
      return browser;
    })
    .catch((err) => {
      _launching = null;
      throw err;
    });

  return _launching;
}

/**
 * Close the shared Puppeteer browser, if running. Call on process shutdown.
 */
async function closeBrowser() {
  if (_browser) {
    await _browser.close();
    _browser = null;
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
  const loadConfig = CONTENT_LOAD_CONFIGS[printType] || CONTENT_LOAD_CONFIGS.exam;

  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      if (request.url().toLowerCase().startsWith("file://")) {
        logger.warn(`Blocked file:// request from print HTML: ${request.url()}`);
        request.abort();
      } else {
        request.continue();
      }
    });

    await page.setContent(injectPrintCsp(html), { waitUntil: loadConfig.waitUntil, timeout: loadConfig.timeout });
    await page.pdf({ path: pdfPath, ...config });

    logger.info(`PDF generated: ${pdfPath} (type: ${printType})`);
    return pdfPath;
  } finally {
    await page.close();
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
  closeBrowser,
};
