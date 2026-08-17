const express = require("express");
const logger = require("../utils/logger");
const { detectLinuxDeviceForced } = require("../services/scanService");
const { getScannerCapabilities } = require("../services/capabilityService");
const { createJob, getJob, cancelJob } = require("../services/autoScanJobManager");
const { RETRY_AFTER_SECONDS } = require("../services/scannerLock");
const { SCANS_DIR } = require("../utils/fileHandler");
const { parseDpi, validateDpi, parsePageCount } = require("../../shared/validateScan");

const router = express.Router();

const ADF_BASE_TIMEOUT_MS = parseInt(process.env.SCAN_TIMEOUT_MS) || 60000;
const ADF_PAGE_TIMEOUT_MS = parseInt(process.env.ADF_PAGE_TIMEOUT_MS) || 15000;

function serializeJob(job) {
  return {
    success: true,
    jobId: job.id,
    status: job.status,
    mode: job.outputMode,
    totalPages: job.totalPages,
    scannedCount: job.scannedCount,
    files: job.files,
    warning: job.warning,
    error: job.error,
    message: job.message,
    scansDirectory: SCANS_DIR,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/scan/auto/start
//
// Kicks off an automatic ADF multi-page scan in the background and returns
// immediately with a jobId — poll GET /api/scan/auto/:jobId for progress
// instead of waiting for every page to finish (which can take minutes for a
// large pageCount). Load every page into the feeder tray first.
//
// Body: { examCode, uniqueId?, pageCount, resolution?, outputMode? }
//   outputMode: "separate" (default — one PDF per page, appears as each page
//   finishes) | "merged" (one PDF, only appears once the whole job completes)
//
// Response 200: { success, jobId, totalPages, estimatedSeconds, message }
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @openapi
 * /api/scan/auto/start:
 *   post:
 *     tags: [Auto Scan (ADF)]
 *     summary: Start an automatic multi-page ADF scan job
 *     description: Kicks off an automatic ADF (feeder) multi-page scan in the background and returns immediately with a jobId — poll GET /api/scan/auto/{jobId} for progress instead of waiting for every page to finish (which can take minutes for a large pageCount). Load every page into the feeder tray first. On Linux/macOS, rejects up front with 400 if the connected scanner has no ADF source (checked via GET /api/capabilities) — unless the capability check itself couldn't complete, in which case the job is allowed to start anyway.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [examCode, pageCount]
 *             properties:
 *               examCode: { type: string }
 *               uniqueId: { type: string, description: "Roll number or center ID" }
 *               pageCount: { type: integer, minimum: 1, maximum: 100, description: "Number of pages loaded in the feeder" }
 *               resolution: { type: integer, minimum: 72, maximum: 1200, default: 300 }
 *               outputMode:
 *                 type: string
 *                 enum: [separate, merged]
 *                 default: separate
 *                 description: "separate — one PDF per page, appears as each page finishes. merged — one PDF, only appears once the whole job completes. merged is not supported on Windows."
 *     responses:
 *       200:
 *         description: Job started (returns immediately, before any page is scanned)
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/AutoScanStartResponse' }
 *       400:
 *         description: Missing examCode, pageCount/resolution out of range, or the connected scanner has no ADF
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 *       422:
 *         description: Unsupported platform, or outputMode "merged" requested on Windows
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 *       503:
 *         description: Scanner is busy with another scan session
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 */
router.post("/scan/auto/start", async (req, res) => {
  const { examCode, uniqueId, pageCount, resolution, outputMode } = req.body;

  if (!examCode || !String(examCode).trim()) {
    return res.status(400).json({ success: false, message: "Missing required field: examCode" });
  }

  const pages = parsePageCount(pageCount, { min: 1, max: 100 });
  if (!pages) {
    return res.status(400).json({ success: false, message: "pageCount must be a number between 1 and 100" });
  }

  const dpi = parseDpi(resolution);
  if (!validateDpi(dpi)) {
    return res.status(400).json({ success: false, message: "resolution must be between 72 and 1200 DPI" });
  }

  const mode = outputMode === "merged" ? "merged" : "separate";
  const uid = uniqueId && String(uniqueId).trim() ? String(uniqueId).trim() : null;
  const exam = String(examCode).trim();
  const platform = process.platform;

  if (platform === "win32" && mode === "merged") {
    return res.status(422).json({
      success: false,
      message: 'outputMode "merged" is not supported on Windows yet — use "separate" instead.',
    });
  }
  if (platform !== "win32" && platform !== "linux" && platform !== "darwin") {
    return res.status(422).json({ success: false, message: `Unsupported platform: ${platform}` });
  }

  let device = "";
  if (platform === "linux" || platform === "darwin") {
    device = await detectLinuxDeviceForced();

    const { adfSupported } = await getScannerCapabilities(device);
    if (adfSupported === false) {
      return res.status(400).json({
        success: false,
        message: `This scanner ("${device || "(default)"}") has no ADF (feeder) — automatic multi-page scanning isn't available. Use POST /api/scan for single-page scans instead.`,
      });
    }
  }

  const timeoutMs = Math.max(ADF_BASE_TIMEOUT_MS, pages * ADF_PAGE_TIMEOUT_MS);
  const job = createJob({ device, platform, examCode: exam, uniqueId: uid, pageCount: pages, resolution: dpi, outputMode: mode, timeoutMs });

  if (!job) {
    return res.status(503).set("Retry-After", String(RETRY_AFTER_SECONDS)).json({
      success: false,
      message: `Scanner is busy with another scan session. Retry in ${RETRY_AFTER_SECONDS} seconds.`,
      retryAfterSeconds: RETRY_AFTER_SECONDS,
    });
  }

  logger.info(`Auto scan job ${job.id} started — exam: ${exam}, pages: ${pages}, mode: ${mode}, platform: ${platform}`);

  return res.json({
    success: true,
    jobId: job.id,
    totalPages: pages,
    estimatedSeconds: pages * (ADF_PAGE_TIMEOUT_MS / 1000),
    message: `Automatic scan started — scanning ${pages} page(s) from the feeder.`,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/scan/auto/:jobId
//
// Poll for progress. `scannedCount` climbs as pages are pulled from the
// feeder; `files` grows live for outputMode "separate" (each entry appears
// as soon as that page is converted), or gets replaced by a single entry
// once outputMode "merged" finishes merging at the end of the job.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @openapi
 * /api/scan/auto/{jobId}:
 *   get:
 *     tags: [Auto Scan (ADF)]
 *     summary: Poll an automatic scan job's progress
 *     description: scannedCount climbs as pages are pulled from the feeder; files grows live for outputMode "separate" (each entry appears as soon as that page is converted), or gets replaced by a single entry once outputMode "merged" finishes merging at the end of the job. Poll every 1-2 seconds while status is "scanning".
 *     parameters:
 *       - in: path
 *         name: jobId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Current job status
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/AutoScanJobResponse' }
 *       404:
 *         description: Job not found — expired or the service was restarted
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 */
router.get("/scan/auto/:jobId", (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) {
    return res.status(404).json({ success: false, message: "Scan job not found. It may have expired or the service was restarted." });
  }
  return res.json(serializeJob(job));
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/scan/auto/:jobId
//
// Cancel a running job. Pages already converted to their own PDF (outputMode
// "separate") stay on disk. For "merged", nothing is written until the very
// end, so cancelling loses the pages scanned so far.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @openapi
 * /api/scan/auto/{jobId}:
 *   delete:
 *     tags: [Auto Scan (ADF)]
 *     summary: Cancel a running automatic scan job
 *     description: Kills the in-progress scanner process. For outputMode "separate", pages already converted to their own PDF before cancelling are kept. For "merged", nothing is written until the very end, so cancelling loses the pages scanned so far.
 *     parameters:
 *       - in: path
 *         name: jobId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Job cancelled
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/AutoScanJobResponse' }
 *       404:
 *         description: Job not found — already finished or expired
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 */
router.delete("/scan/auto/:jobId", (req, res) => {
  const job = cancelJob(req.params.jobId);
  if (!job) {
    return res.status(404).json({ success: false, message: "Scan job not found. It may have already finished or expired." });
  }
  return res.json(serializeJob(job));
});

module.exports = router;
