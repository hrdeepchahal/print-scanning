const express = require("express");
const fs = require("fs");
const logger = require("../utils/logger");
const {
  detectLinuxDevice,
  spawnBatchProcess,
  waitForBatchReady,
  triggerNextBatchPage,
  combinePagesToPdf,
} = require("../services/scanService");
const { createSession, getSession, removeSession } = require("../services/sessionManager");
const { buildOutputPath, validateOutputFile, SCANS_DIR } = require("../utils/fileHandler");

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/scan/start
//
// Begin a multi-page scan session. On Linux/macOS this spawns a persistent
// scanimage --batch process that keeps the device open for all pages, avoiding
// the airscan eSCL re-open conflict that occurred when spawning a new process
// per page.
//
// Body: { uniqueId?, examCode, pageCount, resolution? }
// Response: { success, sessionId, totalPages }
// ─────────────────────────────────────────────────────────────────────────────
router.post("/scan/start", async (req, res) => {
  const { uniqueId, examCode, pageCount, resolution } = req.body;

  if (!examCode || !String(examCode).trim()) {
    return res.status(400).json({ success: false, message: "Missing required field: examCode" });
  }

  const pages = parseInt(pageCount);
  if (!pages || pages < 1 || pages > 100) {
    return res.status(400).json({ success: false, message: "pageCount must be a number between 1 and 100" });
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

  // On Linux/macOS: spawn the persistent batch process now so the device is
  // opened once and stays open for all pages. The process waits for '\n' on
  // stdin before scanning each page.
  if (process.platform === "linux" || process.platform === "darwin") {
    try {
      const device = await detectLinuxDevice();
      session.device = device;

      const { child, pngPaths } = spawnBatchProcess({
        device,
        sessionId: session.id,
        pageCount: pages,
        resolution: dpi,
      });

      session.batchProcess = child;
      session.batchPngPaths = pngPaths;

      // Wait until the process has printed its first "Place document... Press RETURN"
      // prompt — confirms the device opened successfully before we return to the client.
      await waitForBatchReady(child);

      logger.info(`Session ${session.id}: batch process ready (device: ${device || "auto"})`);
    } catch (err) {
      session.status = "cancelled";
      removeSession(session.id, true);
      logger.error(`Session ${session.id}: failed to start batch process — ${err.message}`);
      return res.status(500).json({
        success: false,
        message: `Failed to open scanner: ${err.message}`,
      });
    }
  }

  return res.json({
    success: true,
    sessionId: session.id,
    totalPages: session.totalPages,
    message: `Scanner ready. Place page 1 on the flatbed and call POST /api/scan/page/${session.id}.`,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/scan/page/:sessionId
//
// Scan the next page. On Linux/macOS, signals the persistent batch process via
// stdin — the device was already opened at session start, so there is no
// re-open and no airscan eSCL conflict.
//
// Response: { success, sessionId, currentPage, totalPages, remaining }
// ─────────────────────────────────────────────────────────────────────────────
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
  logger.info(`Session ${sessionId}: scanning page ${pageNumber} of ${session.totalPages}`);

  try {
    if (session.batchProcess) {
      // ── Proper path: persistent batch process ──────────────────────────────
      // The device is already open. Just signal the next page via stdin and
      // wait for the file. No device re-open, no airscan index lookup.
      const pngPath = session.batchPngPaths[pageNumber - 1];
      await triggerNextBatchPage(session.batchProcess, pngPath, session.resolution);

      if (!fs.existsSync(pngPath) || fs.statSync(pngPath).size === 0) {
        throw new Error("Scan completed but image file is missing or empty. Ensure document is on the flatbed.");
      }

      session.scannedPages.push(pngPath);
    } else {
      // ── Windows / fallback path: single-process per page ──────────────────
      const { scanSinglePage } = require("../services/scanService");
      const pngPath = session.batchPngPaths[pageNumber - 1] ||
        require("path").join("/tmp", `eduscan_${sessionId}_page_${pageNumber}.png`);
      const { device } = await scanSinglePage(pngPath, session.resolution);
      if (device && !session.device) session.device = device;

      if (!fs.existsSync(pngPath) || fs.statSync(pngPath).size === 0) {
        throw new Error("Scan command succeeded but image was not created or is empty. Ensure a document is placed face-down on the flatbed.");
      }
      session.scannedPages.push(pngPath);
    }

    const remaining = session.totalPages - session.scannedPages.length;
    logger.info(`Session ${sessionId}: page ${pageNumber} scanned. ${remaining} remaining.`);

    return res.json({
      success: true,
      sessionId,
      currentPage: pageNumber,
      totalPages: session.totalPages,
      remaining,
      message: remaining > 0
        ? `Page ${pageNumber} scanned. Place the next page on the scanner and call this endpoint again.`
        : `All pages scanned. Call POST /api/scan/complete/${sessionId} to create the PDF.`,
    });
  } catch (err) {
    logger.error(`Session ${sessionId}: page ${pageNumber} failed — ${err.message}`);

    const isClientError =
      err.message.includes("not found") ||
      err.message.includes("not installed") ||
      err.message.includes("not connected") ||
      err.message.includes("Unsupported platform") ||
      err.message.includes("face-down");

    return res.status(isClientError ? 422 : 500).json({
      success: false,
      sessionId,
      currentPage: pageNumber,
      message: err.message,
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/scan/complete/:sessionId
//
// Merge all scanned PNGs into a single PDF.
// ─────────────────────────────────────────────────────────────────────────────
router.post("/scan/complete/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  const session = getSession(sessionId);

  if (!session) {
    return res.status(404).json({ success: false, message: "Session not found. It may have expired or already been completed." });
  }

  if (session.status !== "active") {
    return res.status(409).json({ success: false, message: `Session is "${session.status}" and cannot be completed.` });
  }

  if (session.scannedPages.length === 0) {
    return res.status(400).json({ success: false, message: "No pages have been scanned yet." });
  }

  if (session.scannedPages.length < session.totalPages) {
    return res.status(400).json({
      success: false,
      message: `Only ${session.scannedPages.length} of ${session.totalPages} pages scanned. Scan the remaining pages or cancel.`,
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
      message: `Scan complete. ${session.totalPages} page(s) merged into ${filename}`,
    });
  } catch (err) {
    session.status = "active";
    logger.error(`Session ${sessionId}: PDF merge failed — ${err.message}`);
    return res.status(500).json({ success: false, sessionId, message: `Failed to create PDF: ${err.message}` });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/scan/session/:sessionId
// ─────────────────────────────────────────────────────────────────────────────
router.delete("/scan/session/:sessionId", (req, res) => {
  const { sessionId } = req.params;
  const session = getSession(sessionId);

  if (!session) {
    return res.status(404).json({ success: false, message: "Session not found. It may have already been completed or expired." });
  }

  const pagesScanned = session.scannedPages.length;
  session.status = "cancelled";
  removeSession(sessionId, true);

  logger.info(`Session ${sessionId}: cancelled (${pagesScanned} pages cleaned up)`);

  return res.json({
    success: true,
    message: `Session cancelled. ${pagesScanned} temporary page(s) cleaned up.`,
  });
});

module.exports = router;
