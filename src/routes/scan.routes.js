const express = require("express");
const { executeScan } = require("../services/scanService");
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
    service: "Print Scanning Service",
    platform: process.platform,
    port: process.env.PORT || 4545,
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /api/scan
 *
 * Query parameters:
 *   rollNumber  {string}  required — student roll number (used in filename)
 *   examCode    {string}  required — exam code (used in filename)
 *   resolution  {number}  optional — scan DPI, defaults to 300
 *
 * Response (200):
 *   { success: true, filename, filePath, platform }
 *
 * Response (4xx / 5xx):
 *   { success: false, message }
 */
router.get("/scan", async (req, res) => {
  const { rollNumber, examCode, resolution } = req.query;

  // Validate required parameters
  if (!rollNumber || !rollNumber.trim()) {
    return res.status(400).json({
      success: false,
      message: "Missing required query parameter: rollNumber",
    });
  }

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

  logger.info(`Scan request received — rollNumber: ${rollNumber.trim()}, examCode: ${examCode.trim()}, resolution: ${dpi}`);

  try {
    const result = await executeScan({
      rollNumber: rollNumber.trim(),
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
  }
});

module.exports = router;
