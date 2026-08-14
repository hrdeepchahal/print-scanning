const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const logger = require("../utils/logger");
const { buildOutputPath, buildPageOutputPath, makeTimestamp } = require("../utils/fileHandler");
const {
  buildSaneArgs,
  convertPngToPdf,
  combinePagesToPdf,
  scanSinglePage,
  checkPageDimensions,
  invalidateDeviceCache,
  isDeviceOpenFailure,
} = require("./scanService");
const { acquireScannerLock, releaseScannerLock } = require("./scannerLock");
const { createOpenIndex } = require("./crashRecovery");

// ─────────────────────────────────────────────────────────────────────────────
// Background job runner for POST /api/scan/auto/start.
//
// Unlike the old synchronous /api/scan/auto (one blocking call that only
// returned once every page was scanned), this tracks progress in memory as
// pages land, so a client can poll GET /api/scan/auto/:jobId and update a
// live "N of M scanned" counter / doc grid instead of waiting for the whole
// batch to finish. Modeled on sessionManager.js's session store.
// ─────────────────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 400;
const JOB_RETENTION_MS = parseInt(process.env.SCAN_SESSION_TIMEOUT_MS) || 30 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

/** @type {Map<string, object>} */
const jobs = new Map();

// Crash/restart recovery — see crashRecovery.js for why this is cleanup-only
// and never resumes a job.
const jobIndex = createOpenIndex(".jobs-open.json", (id) => `eduscan_auto_${id}_`);
jobIndex.recoverOrphaned();

function generateId() {
  return crypto.randomBytes(8).toString("hex");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanupPaths(paths) {
  for (const p of paths) {
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch (_) {}
  }
}

/**
 * Start a new automatic scan job and return its initial (still "scanning")
 * state immediately — the actual scanning runs in the background.
 *
 * @param {{ device: string, platform: string, examCode: string, uniqueId: string|null,
 *           pageCount: number, resolution: number, outputMode: "separate"|"merged", timeoutMs: number }} opts
 * @returns {object|null} the new job, or null if the scanner is already in use by another job/session
 */
function createJob({ device, platform, examCode, uniqueId, pageCount, resolution, outputMode, timeoutMs }) {
  const job = {
    id: generateId(),
    examCode,
    uniqueId,
    pageCount,
    resolution,
    outputMode,
    device,
    platform,
    timestamp: makeTimestamp(),
    status: "scanning", // scanning | completed | failed | cancelled
    scannedCount: 0,
    totalPages: pageCount,
    files: [],
    warning: null,
    error: null,
    message: null,
    child: null,
    createdAt: Date.now(),
    _pendingPngPaths: [],
  };

  // Held for the job's entire background runtime (not just this call) —
  // released in the .finally() below once the runner actually finishes.
  if (!acquireScannerLock(job.id)) return null;

  jobs.set(job.id, job);
  jobIndex.markOpen(job.id);

  const runner = platform === "win32" ? runWindowsJob : runLinuxJob;
  runner(job, timeoutMs)
    .catch((err) => {
      logger.error(`Auto scan job ${job.id} crashed: ${err.message}`);
      if (job.status === "scanning") {
        job.status = "failed";
        job.error = err.message;
      }
    })
    .finally(() => {
      releaseScannerLock(job.id);
      jobIndex.markClosed(job.id);
    });

  return job;
}

function getJob(id) {
  return jobs.get(id);
}

/** Cancel a running job. Pages already converted to PDF stay on disk. */
function cancelJob(id) {
  const job = jobs.get(id);
  if (!job) return null;
  if (job.status === "scanning") {
    if (job.child && job.child.exitCode === null && !job.child.killed) {
      try {
        job.child.kill("SIGTERM");
      } catch (_) {}
    }
    job.status = "cancelled";
    job.message = `Cancelled — ${job.scannedCount} page(s) already scanned remain saved.`;
  }
  cleanupPaths(job._pendingPngPaths);
  job._pendingPngPaths = [];
  return job;
}

// ── Linux / macOS — one scanimage --batch process, polled for new pages ────

async function runLinuxJob(job, timeoutMs) {
  const pngPattern = path.join("/tmp", `eduscan_auto_${job.id}_%03d.png`);
  const args = [
    ...buildSaneArgs(job.device, job.resolution),
    "--source", "ADF",
    "--format", "png",
    `--batch=${pngPattern}`,
    `--batch-count=${job.pageCount}`,
  ];

  logger.info(`Auto scan job ${job.id}: scanimage ${args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")}`);

  const child = spawn("scanimage", args, { stdio: ["ignore", "pipe", "pipe"] });
  job.child = child;

  const launchError = await new Promise((resolve) => {
    child.once("error", (err) => resolve(err));
    child.once("spawn", () => resolve(null));
  });
  if (launchError) {
    job.status = "failed";
    job.error = `Failed to launch ADF scan: ${launchError.message}`;
    return;
  }

  const pngPaths = Array.from({ length: job.pageCount }, (_, i) =>
    path.join("/tmp", `eduscan_auto_${job.id}_${String(i + 1).padStart(3, "0")}.png`)
  );

  let stderrBuf = "";
  child.stdout.on("data", () => {});
  child.stderr.on("data", (d) => {
    stderrBuf += d.toString();
  });

  const deadline = Date.now() + timeoutMs;
  let nextIndex = 0;
  let timedOut = false;

  while (job.status === "scanning") {
    while (
      job.status === "scanning" &&
      nextIndex < job.pageCount &&
      fs.existsSync(pngPaths[nextIndex]) &&
      fs.statSync(pngPaths[nextIndex]).size > 0
    ) {
      await handlePageScanned(job, nextIndex + 1, pngPaths[nextIndex]);
      nextIndex++;
    }
    if (job.status !== "scanning") break;

    if (child.exitCode !== null || child.killed) {
      await finalize(job, nextIndex, stderrBuf.trim());
      break;
    }

    if (Date.now() > deadline) {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch (_) {}
      await finalize(job, nextIndex, stderrBuf.trim(), timeoutMs);
      break;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  cleanupPaths(pngPaths.slice(nextIndex));
  if (timedOut) logger.warn(`Auto scan job ${job.id}: timed out after ${timeoutMs}ms with ${nextIndex} page(s) scanned.`);
}

// ── Windows — NAPS2 called once per page (no ADF batch primitive here) ─────
// NAPS2 console writes a PDF directly (no PNG intermediate), so for
// "separate" mode each page's own output IS the final file — no conversion
// step needed. "merged" isn't supported on this path: merging already-final
// PDFs would need a PDF-merge library this backend doesn't carry yet.

async function runWindowsJob(job) {
  if (job.outputMode === "merged") {
    job.status = "failed";
    job.error = "outputMode \"merged\" is not supported on Windows yet — use \"separate\" instead.";
    return;
  }

  for (let i = 0; i < job.pageCount; i++) {
    if (job.status !== "scanning") break;
    const pageNumber = i + 1;
    const tmpBase = path.join("/tmp", `eduscan_auto_${job.id}_${String(pageNumber).padStart(3, "0")}.png`);
    try {
      await scanSinglePage(tmpBase, job.resolution);
      const producedPdf = tmpBase.replace(/\.png$/i, ".pdf");
      if (!fs.existsSync(producedPdf) || fs.statSync(producedPdf).size === 0) {
        job.warning = `Only ${job.scannedCount} of ${job.pageCount} requested page(s) were scanned — the feeder likely ran out of paper.`;
        break;
      }
      const { filename, filePath } = buildPageOutputPath(job.uniqueId, job.examCode, pageNumber, job.pageCount, job.timestamp);
      fs.renameSync(producedPdf, filePath);
      job.scannedCount = pageNumber;
      job.files.push({ page: pageNumber, filename, filePath });
    } catch (err) {
      if (job.scannedCount === 0) {
        job.status = "failed";
        job.error = err.message;
        return;
      }
      job.warning = `Stopped after ${job.scannedCount} of ${job.pageCount} page(s): ${err.message}`;
      break;
    }
  }

  if (job.status !== "scanning") return; // cancelled mid-loop
  job.totalPages = job.scannedCount;
  job.status = "completed";
  job.message = `${job.scannedCount} page(s) scanned and saved as ${job.scannedCount} separate PDF(s)`;
}

// ── Shared helpers ──────────────────────────────────────────────────────────

async function handlePageScanned(job, pageNumber, pngPath) {
  job.scannedCount = pageNumber;
  await checkPageDimensions(pngPath, job.resolution);

  if (job.outputMode === "merged") {
    job._pendingPngPaths.push(pngPath);
    return;
  }

  try {
    const { filename, filePath } = buildPageOutputPath(job.uniqueId, job.examCode, pageNumber, job.pageCount, job.timestamp);
    await convertPngToPdf(pngPath, filePath);
    job.files.push({ page: pageNumber, filename, filePath });
  } catch (err) {
    logger.error(`Auto scan job ${job.id}: page ${pageNumber} conversion failed — ${err.message}`);
    job.warning = `Page ${pageNumber} scanned but failed to convert to PDF: ${err.message}`;
  } finally {
    try {
      fs.unlinkSync(pngPath);
    } catch (_) {}
  }
}

async function finalize(job, scannedCount, stderrTail, timedOutAfterMs) {
  if (job.status !== "scanning") return; // already cancelled

  if (scannedCount === 0) {
    job.status = "failed";
    if (isDeviceOpenFailure(stderrTail)) invalidateDeviceCache();
    job.error = timedOutAfterMs
      ? `ADF scan timed out after ${timedOutAfterMs / 1000}s without scanning any pages.`
      : stderrTail || "ADF scan process exited without producing any pages. Ensure documents are loaded in the feeder.";
    return;
  }

  if (timedOutAfterMs) {
    job.warning = `Timed out after ${timedOutAfterMs / 1000}s — saved ${scannedCount} of ${job.pageCount} requested page(s).`;
  } else if (scannedCount < job.pageCount) {
    job.warning = `Only ${scannedCount} of ${job.pageCount} requested page(s) were scanned — the feeder likely ran out of paper.`;
  }

  job.totalPages = scannedCount;

  if (job.outputMode === "merged") {
    try {
      const { filename, filePath } = buildOutputPath(job.uniqueId, job.examCode, job.timestamp);
      await combinePagesToPdf(job._pendingPngPaths, filePath);
      job.files = [{ filename, filePath }];
    } catch (err) {
      job.status = "failed";
      job.error = `Failed to merge pages into PDF: ${err.message}`;
      return;
    } finally {
      cleanupPaths(job._pendingPngPaths);
      job._pendingPngPaths = [];
    }
    job.message = `${scannedCount} page(s) scanned and merged into ${job.files[0].filename}`;
  } else {
    job.message = `${scannedCount} page(s) scanned and saved as ${scannedCount} separate PDF(s)`;
  }

  job.status = "completed";
}

function purgeOldJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > JOB_RETENTION_MS) {
      if (job.status === "scanning") cancelJob(id);
      jobs.delete(id);
    }
  }
}

const cleanupTimer = setInterval(purgeOldJobs, CLEANUP_INTERVAL_MS);
cleanupTimer.unref();

module.exports = { createJob, getJob, cancelJob };
