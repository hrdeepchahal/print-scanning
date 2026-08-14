const express = require("express");
const { executeScan } = require("../services/scanService");
const { acquireScannerLock, releaseScannerLock } = require("../services/scannerLock");
const logger = require("../utils/logger");
const { SCANS_DIR } = require("../utils/fileHandler");

const router = express.Router();

/**
 * GET /api/health
 * Lightweight health check — confirms the service is running.
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
 * GET /api/scan
 *
 * Query parameters:
 *   uniqueId    {string}  optional — identifier printed on the sheet (roll number, center ID, etc.)
 *                         When omitted, the PDF is named <examCode>_<timestamp>.pdf
 *   examCode    {string}  required — exam code (used in filename and folder)
 *   resolution  {number}  optional — scan DPI, defaults to 300
 *
 * Response (200):
 *   { success: true, filename, filePath, platform }
 *
 * Response (4xx / 5xx):
 *   { success: false, message }
 */
router.get("/scan", async (req, res) => {
  const { uniqueId, examCode, resolution } = req.query;

  if (!examCode || !examCode.trim()) {
    return res.status(400).json({
      success: false,
      message: "Missing required query parameter: examCode",
    });
  }

  const dpi = parseInt(resolution) || 300;
  if (dpi < 72 || dpi > 1200) {
    return res.status(400).json({
      success: false,
      message: "resolution must be between 72 and 1200 DPI",
    });
  }

  const uid = uniqueId && uniqueId.trim() ? uniqueId.trim() : null;
  logger.info(`Scan request received — uniqueId: ${uid || "(none)"}, examCode: ${examCode.trim()}, resolution: ${dpi}`);

  if (!acquireScannerLock("legacy-scan")) {
    return res.status(503).set("Retry-After", "5").json({
      success: false,
      message: "Scanner is busy with another scan session. Retry in 5 seconds.",
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
    const isClientError =
      err.message.includes("not found") ||
      err.message.includes("not installed") ||
      err.message.includes("not connected") ||
      err.message.includes("Unsupported platform");

    return res.status(isClientError ? 422 : 500).json({
      success: false,
      message: err.message,
    });
  } finally {
    releaseScannerLock("legacy-scan");
  }
});

module.exports = router;
