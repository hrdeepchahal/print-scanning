const express = require("express");
const { v4: uuidv4 } = require("uuid");
const { printFromHtml } = require("../services/printService");
const { listPrinters } = require("../services/printerService");
const logger = require("../utils/logger");

const router = express.Router();

/**
 * POST /api/print
 *
 * Body:
 *   html       {string}  HTML content to render and print
 *   base64Pdf  {string}  (future) pre-rendered PDF as base64
 *   printerName {string} optional — target printer (uses default if omitted)
 *   printType  {string}  "exam" (0.25in margins) or "omr" (0 margins, scale 1)
 *   duplex     {boolean} optional — double-sided if true, single-sided if
 *                        false. Defaults to PRINT_DUPLEX_DEFAULT when omitted.
 *                        Downgraded to single-sided automatically (with a
 *                        `warning` in the response) if the printer doesn't
 *                        support duplex — see GET /api/capabilities.
 *
 * Response (200): { success, message, jobId, warning? }
 * Response (4xx/5xx): { success: false, message, jobId }
 */
/**
 * @openapi
 * /api/print:
 *   post:
 *     tags: [Printing]
 *     summary: Silently print HTML content
 *     description: Renders HTML to a PDF via Puppeteer and sends it to the OS print spooler (CUPS `lp` on Linux/macOS, pdf-to-printer on Windows) — no print dialog, no user interaction. If duplex is requested but the printer's CUPS driver doesn't support it (checked via GET /api/capabilities), the job is automatically printed single-sided instead and a warning is included in the response — it never fails or drops pages.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               html: { type: string, description: "Full HTML document to render and print. Either html or base64Pdf is required." }
 *               base64Pdf: { type: string, description: "(future) pre-rendered PDF as base64" }
 *               printerName: { type: string, description: "Target printer name (from GET /api/printers). Uses PRINTER_NAME env / system default if omitted." }
 *               printType: { type: string, enum: [exam, omr], default: exam, description: "exam = 0.25in margins. omr = 0 margins, scale 1." }
 *               duplex: { type: boolean, description: "true = double-sided (long-edge flip), false = single-sided. Defaults to PRINT_DUPLEX_DEFAULT env when omitted." }
 *     responses:
 *       200:
 *         description: Print job queued (warning present if duplex was downgraded)
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/PrintResponse' }
 *       400:
 *         description: Missing html/base64Pdf, invalid printType, or duplex is not a boolean
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 *       500:
 *         description: Print failed (e.g. printer not found, spooler error)
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 */
router.post("/print", async (req, res) => {
  const { html, base64Pdf, printerName, printType = "exam", duplex } = req.body;

  if (!html && !base64Pdf) {
    return res.status(400).json({
      success: false,
      message: "Request body must include 'html' or 'base64Pdf'",
    });
  }

  if (!["exam", "omr"].includes(printType)) {
    return res.status(400).json({
      success: false,
      message: "printType must be 'exam' or 'omr'",
    });
  }

  if (duplex !== undefined && typeof duplex !== "boolean") {
    return res.status(400).json({
      success: false,
      message: "duplex must be a boolean",
    });
  }

  const resolvedDuplex = typeof duplex === "boolean" ? duplex : process.env.PRINT_DUPLEX_DEFAULT === "true";

  const jobId = uuidv4();
  logger.info(`Print request [${jobId}] — type: ${printType}, printer: ${printerName || "(default)"}, duplex: ${resolvedDuplex}`);

  try {
    const printer = printerName || process.env.PRINTER_NAME || null;
    const { appliedDuplex } = await printFromHtml(html, printType, printer, resolvedDuplex);

    const response = {
      success: true,
      message: "Print job queued successfully",
      jobId,
    };
    if (resolvedDuplex && !appliedDuplex) {
      response.warning = `Printer "${printer || "(default)"}" doesn't support duplex — printed single-sided instead.`;
    }

    res.json(response);
  } catch (err) {
    logger.error(`Print failed [${jobId}]: ${err.message}`, { stack: err.stack });
    res.status(500).json({
      success: false,
      message: err.message,
      jobId,
    });
  }
});

/**
 * @openapi
 * /api/printers:
 *   get:
 *     tags: [Printing]
 *     summary: List available printers + system default
 *     description: Windows uses pdf-to-printer; Linux/macOS parses CUPS `lpstat -p -d` output. Use the returned names in printerName when calling POST /api/print.
 *     responses:
 *       200:
 *         description: Printers found
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/PrintersResponse' }
 *       500:
 *         description: Failed to list printers
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 */
router.get("/printers", async (req, res) => {
  try {
    const result = await listPrinters();
    res.json({ success: true, ...result });
  } catch (err) {
    logger.error(`List printers failed: ${err.message}`);
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
});

module.exports = router;
