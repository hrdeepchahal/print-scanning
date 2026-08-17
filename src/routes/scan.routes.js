const express = require("express");
const { executeScan } = require("../services/scanService");
const { acquireScannerLock, releaseScannerLock, RETRY_AFTER_SECONDS } = require("../services/scannerLock");
const logger = require("../utils/logger");
const { SCANS_DIR } = require("../utils/fileHandler");
const { parseDpi, validateDpi, isClientError } = require("../../shared/validateScan");

const router = express.Router();

/**
 * @openapi
 * /api/health:
 *   get:
 *     tags: [Health]
 *     summary: Service liveness check
 *     description: Lightweight health check — confirms the service is running.
 *     responses:
 *       200:
 *         description: Service is running
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/HealthResponse'
 */
router.get("/health", (req, res) => {
  res.json({
    success: true,
    status: "ok",
    service: "Print Scanning Local Service",
    platform: process.platform,
    port: process.env.PORT || 4545,
    timestamp: new Date().toISOString(),
    capabilities: ["scan", "print"],
  });
});

/**
 * @openapi
 * /api/scan:
 *   get:
 *     tags: [Scanning]
 *     summary: Scan a single page (flatbed)
 *     description: Scans one page from the flatbed and saves it as a PDF. For multi-page documents, use the Scan Sessions or Auto Scan (ADF) endpoints instead.
 *     parameters:
 *       - in: query
 *         name: examCode
 *         required: true
 *         schema: { type: string }
 *         description: Exam code — used in the output filename and folder.
 *       - in: query
 *         name: uniqueId
 *         schema: { type: string }
 *         description: Identifier printed on the sheet (roll number, center ID, etc). When omitted, the PDF is named <examCode>_<timestamp>.pdf.
 *       - in: query
 *         name: resolution
 *         schema: { type: integer, minimum: 72, maximum: 1200, default: 300 }
 *         description: Scan DPI.
 *     responses:
 *       200:
 *         description: Page scanned and saved
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ScanResult' }
 *       400:
 *         description: Missing examCode, or resolution out of range
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 *       422:
 *         description: Client-fixable scanner error (device not found/not installed/not connected)
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 *       500:
 *         description: Scanner/hardware error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 *       503:
 *         description: Scanner is busy with another scan session
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 */
router.get("/scan", async (req, res) => {
  const { uniqueId, examCode, resolution } = req.query;

  if (!examCode || !examCode.trim()) {
    return res.status(400).json({
      success: false,
      message: "Missing required query parameter: examCode",
    });
  }

  const dpi = parseDpi(resolution);
  if (!validateDpi(dpi)) {
    return res.status(400).json({
      success: false,
      message: "resolution must be between 72 and 1200 DPI",
    });
  }

  const uid = uniqueId && uniqueId.trim() ? uniqueId.trim() : null;
  logger.info(`Scan request received — uniqueId: ${uid || "(none)"}, examCode: ${examCode.trim()}, resolution: ${dpi}`);

  if (!acquireScannerLock("legacy-scan")) {
    return res.status(503).set("Retry-After", String(RETRY_AFTER_SECONDS)).json({
      success: false,
      message: `Scanner is busy with another scan session. Retry in ${RETRY_AFTER_SECONDS} seconds.`,
      retryAfterSeconds: RETRY_AFTER_SECONDS,
    });
  }

  try {
    const result = await executeScan({
      uniqueId: uid,
      examCode: examCode.trim(),
      resolution: dpi,
    });

    return res.json({
      success: true,
      filename: result.filename,
      filePath: result.filePath,
      platform: result.platform,
      device: result.device || null,
      scansDirectory: SCANS_DIR,
      message: "Document scanned and saved successfully",
    });
  } catch (err) {
    logger.error(`Scan failed: ${err.message}`);

    // Distinguish between client errors and server/hardware errors
    return res.status(isClientError(err) ? 422 : 500).json({
      success: false,
      message: err.message,
    });
  } finally {
    releaseScannerLock("legacy-scan");
  }
});

module.exports = router;
