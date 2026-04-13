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
 *
 * Response (200): { success, message, jobId }
 * Response (4xx/5xx): { success: false, message, jobId }
 */
router.post("/print", async (req, res) => {
  const { html, base64Pdf, printerName, printType = "exam" } = req.body;

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

  const jobId = uuidv4();
  logger.info(`Print request [${jobId}] — type: ${printType}, printer: ${printerName || "(default)"}`);

  try {
    const printer = printerName || process.env.PRINTER_NAME || null;
    await printFromHtml(html, printType, printer);

    res.json({
      success: true,
      message: "Print job queued successfully",
      jobId,
    });
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
 * GET /api/printers
 *
 * Response (200): { success, printers: string[], default: string }
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
