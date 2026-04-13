const express = require("express");
const path = require("path");
const fs = require("fs");
const logger = require("../utils/logger");
const { scanSinglePage, combinePagesToPdf } = require("../services/scanService");
const {
  createSession,
  getSession,
  removeSession,
} = require("../services/sessionManager");
const {
  buildOutputPath,
  validateOutputFile,
  SCANS_DIR,
} = require("../utils/fileHandler");

const router = express.Router();

/**
 * POST /api/scan/start
 *
 * Begin a multi-page scan session.
 *
 * Body: { uniqueId?, examCode, pageCount, resolution? }
 *   uniqueId   optional — identifier (roll number, center ID, etc.)
 * Response: { success, sessionId, totalPages }
 */
router.post("/scan/start", (req, res) => {
  const { uniqueId, examCode, pageCount, resolution } = req.body;

  if (!examCode || !String(examCode).trim()) {
    return res.status(400).json({ success: false, message: "Missing required field: examCode" });
  }

  const pages = parseInt(pageCount);
  if (!pages || pages < 1 || pages > 100) {
    return res.status(400).json({
      success: false,
      message: "pageCount must be a number between 1 and 100",
    });
  }

  const dpi = parseInt(resolution) || 300;
  if (dpi < 72 || dpi > 1200) {
    return res.status(400).json({ success: false, message: "resolution must be between 72 and 1200 DPI" });
  }

  const uid = uniqueId && String(uniqueId).trim() ? String(uniqueId).trim() : null;

  const session = createSession({
    uniqueId: uid,
    examCode: String(examCode).trim(),
    totalPages: pages,
    resolution: dpi,
  });

  return res.json({
    success: true,
    sessionId: session.id,
    totalPages: session.totalPages,
    message: `Multi-page scan session started. Scan ${session.totalPages} page(s) one by one.`,
  });
});

/**
 * POST /api/scan/page/:sessionId
 *
 * Scan the next page in an active session.
 * The user should place the next page on the flatbed before calling this.
 *
 * Response: { success, sessionId, currentPage, totalPages, remaining }
 */
router.post("/scan/page/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  const session = getSession(sessionId);

  if (!session) {
    return res.status(404).json({
      success: false,
      message: "Session not found. It may have expired, been completed, or the service was restarted.",
    });
  }

  if (session.status !== "active") {
    return res.status(409).json({
      success: false,
      message: `Session is "${session.status}" and cannot accept more pages.`,
    });
  }

  if (session.scannedPages.length >= session.totalPages) {
    return res.status(409).json({
      success: false,
      message: `All ${session.totalPages} pages have already been scanned. Call POST /api/scan/complete/${sessionId} to finalize.`,
    });
  }

  const pageNumber = session.scannedPages.length + 1;
  const pngPath = path.join("/tmp", `eduscan_${sessionId}_page_${pageNumber}.png`);

  logger.info(`Session ${sessionId}: scanning page ${pageNumber} of ${session.totalPages}`);

  try {
    const { device } = await scanSinglePage(pngPath, session.resolution);
    if (device && !session.device) session.device = device;

    if (!fs.existsSync(pngPath) || fs.statSync(pngPath).size === 0) {
      throw new Error(
        "Scan command succeeded but image was not created or is empty. " +
        "Ensure a document is placed face-down on the flatbed and retry."
      );
    }

    session.scannedPages.push(pngPath);
    const remaining = session.totalPages - session.scannedPages.length;

    logger.info(`Session ${sessionId}: page ${pageNumber} scanned successfully. ${remaining} remaining.`);

    return res.json({
      success: true,
      sessionId,
      currentPage: pageNumber,
      totalPages: session.totalPages,
      remaining,
      message: remaining > 0
        ? `Page ${pageNumber} scanned. Place the next page on the scanner and scan again.`
        : `Page ${pageNumber} scanned. All pages done — call POST /api/scan/complete/${sessionId} to create the PDF.`,
    });
  } catch (err) {
    logger.error(`Session ${sessionId}: page ${pageNumber} scan failed — ${err.message}`);

    const isClientError =
      err.message.includes("not found") ||
      err.message.includes("not installed") ||
      err.message.includes("not connected") ||
      err.message.includes("Unsupported platform");

    return res.status(isClientError ? 422 : 500).json({
      success: false,
      sessionId,
      currentPage: pageNumber,
      message: err.message,
    });
  }
});

/**
 * POST /api/scan/complete/:sessionId
 *
 * Finalize a session: merge all scanned pages into a single PDF.
 *
 * Response: same shape as GET /api/scan (success, filename, filePath, ...)
 */
router.post("/scan/complete/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  const session = getSession(sessionId);

  if (!session) {
    return res.status(404).json({
      success: false,
      message: "Session not found. It may have expired, been completed, or the service was restarted.",
    });
  }

  if (session.status !== "active") {
    return res.status(409).json({
      success: false,
      message: `Session is "${session.status}" and cannot be completed.`,
    });
  }

  if (session.scannedPages.length === 0) {
    return res.status(400).json({
      success: false,
      message: "No pages have been scanned yet. Scan at least one page before completing.",
    });
  }

  if (session.scannedPages.length < session.totalPages) {
    return res.status(400).json({
      success: false,
      message: `Only ${session.scannedPages.length} of ${session.totalPages} pages scanned. Scan the remaining pages or cancel the session.`,
    });
  }

  session.status = "completing";

  try {
    const { filename, filePath } = buildOutputPath(session.uniqueId, session.examCode);

    await combinePagesToPdf(session.scannedPages, filePath);

    if (!validateOutputFile(filePath)) {
      throw new Error("PDF was not created or is empty after merging pages.");
    }

    session.status = "completed";
    removeSession(sessionId, true);

    logger.info(`Session ${sessionId}: PDF created — ${filename} (${session.totalPages} pages)`);

    return res.json({
      success: true,
      filename,
      filePath,
      platform: session.platform,
      device: session.device || null,
      scansDirectory: SCANS_DIR,
      totalPages: session.totalPages,
      message: `Multi-page scan complete. ${session.totalPages} page(s) merged into ${filename}`,
    });
  } catch (err) {
    session.status = "active";
    logger.error(`Session ${sessionId}: PDF merge failed — ${err.message}`);
    return res.status(500).json({
      success: false,
      sessionId,
      message: `Failed to create PDF: ${err.message}`,
    });
  }
});

/**
 * DELETE /api/scan/session/:sessionId
 *
 * Cancel an active session and clean up temp files.
 */
router.delete("/scan/session/:sessionId", (req, res) => {
  const { sessionId } = req.params;
  const session = getSession(sessionId);

  if (!session) {
    return res.status(404).json({
      success: false,
      message: "Session not found. It may have already been completed or expired.",
    });
  }

  const pagesScanned = session.scannedPages.length;
  session.status = "cancelled";
  removeSession(sessionId, true);

  logger.info(`Session ${sessionId}: cancelled by user (${pagesScanned} pages cleaned up)`);

  return res.json({
    success: true,
    message: `Session cancelled. ${pagesScanned} temporary page(s) cleaned up.`,
  });
});

module.exports = router;
