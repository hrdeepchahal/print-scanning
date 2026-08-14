const { exec, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const { PDFDocument } = require("pdf-lib");
const logger = require("../utils/logger");
const { buildOutputPath, validateOutputFile } = require("../utils/fileHandler");

const SCAN_TIMEOUT_MS = parseInt(process.env.SCAN_TIMEOUT_MS) || 60000;
const SANE_DEVICE_CACHE_MS = parseInt(process.env.SANE_DEVICE_CACHE_MS) || 300000;
const AIRSCAN_RETRY_DELAY_MS = parseInt(process.env.AIRSCAN_RETRY_DELAY_MS) || 10000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const NAPS2_PATH =
  process.env.NAPS2_PATH ||
  "C:\\Program Files\\NAPS2\\naps2.console.exe";

function execAsync(command, timeoutMs = SCAN_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const child = exec(command, { timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        const message =
          error.killed || error.code === "ETIMEDOUT"
            ? `Scan timed out after ${timeoutMs / 1000}s. Is the scanner connected and ready?`
            : stderr?.trim() || error.message;
        return reject(new Error(message));
      }
      resolve({ stdout: stdout?.trim(), stderr: stderr?.trim() });
    });
    child.on("error", (err) => reject(new Error(`Failed to launch scan command: ${err.message}`)));
  });
}

/**
 * Same contract as execAsync, but via spawn(cmd, argsArray) — no shell, so
 * args (device names off scanimage -L, which come from mDNS and are not
 * trusted) can't be interpreted as shell metacharacters no matter what they
 * contain.
 */
function spawnAsync(cmd, args, timeoutMs = SCAN_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to launch ${cmd}: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        return reject(new Error(`Scan timed out after ${timeoutMs / 1000}s. Is the scanner connected and ready?`));
      }
      if (code !== 0) {
        return reject(new Error(stderr.trim() || `${cmd} exited with code ${code}`));
      }
      resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

/**
 * Auto-detect the best SANE device. Prefers SANE_DEVICE env var, then
 * pixma/Canon devices from scanimage -L, then first non-webcam.
 */
async function detectLinuxDevice() {
  if (process.env.SANE_DEVICE) {
    logger.info(`Using pinned SANE_DEVICE: ${process.env.SANE_DEVICE}`);
    return process.env.SANE_DEVICE;
  }
  return detectLinuxDeviceForced();
}

let _deviceCache = { device: null, expiresAt: 0 };

function cacheDevice(device) {
  _deviceCache = { device, expiresAt: Date.now() + SANE_DEVICE_CACHE_MS };
  return device;
}

/**
 * Force the next detectLinuxDeviceForced() call to re-run scanimage -L
 * instead of reusing the cached device name. Call this after a device-open
 * failure — the airscan:eN positional index can shift after the scanner
 * re-advertises via mDNS, so a cached name may no longer be valid.
 */
function invalidateDeviceCache() {
  _deviceCache = { device: null, expiresAt: 0 };
}

/**
 * Always runs scanimage -L regardless of SANE_DEVICE env (subject to the
 * SANE_DEVICE_CACHE_MS cache below — scanimage -L takes ~10s on a network
 * scanner, so re-running it on every scan start is wasteful when the device
 * list hasn't changed).
 */
async function detectLinuxDeviceForced() {
  if (_deviceCache.device && Date.now() < _deviceCache.expiresAt) {
    logger.info(`Using cached SANE device: ${_deviceCache.device}`);
    return _deviceCache.device;
  }

  try {
    const { stdout } = await execAsync("scanimage -L 2>/dev/null", 15000);
    if (!stdout) {
      logger.warn("scanimage -L returned no output — no scanner detected");
      return "";
    }
    const extractName = (line) => { const m = line.match(/device `([^']+)'/); return m ? m[1] : null; };
    const allDevices = stdout.split("\n").filter((l) => l.includes("device `")).map(extractName).filter(Boolean);
    logger.info(`Detected SANE devices: ${allDevices.join(", ")}`);

    const pinned = process.env.SANE_DEVICE?.trim();
    if (pinned) {
      const matched = matchPinnedDevice(allDevices, pinned);
      if (matched) {
        logger.info(`Matched SANE_DEVICE "${pinned}" → ${matched}`);
        return cacheDevice(matched);
      }
      logger.warn(`SANE_DEVICE "${pinned}" not found in scanimage -L output`);
    }

    const preferred = allDevices.find((d) => d.startsWith("pixma:") || d.toLowerCase().includes("canon"));
    if (preferred) { logger.info(`Auto-selected device: ${preferred}`); return cacheDevice(preferred); }

    const nonWebcam = allDevices.find((d) => !d.startsWith("v4l:"));
    if (nonWebcam) { logger.info(`Auto-selected non-webcam device: ${nonWebcam}`); return cacheDevice(nonWebcam); }

    logger.warn("Only webcam (v4l) devices found — scan may fail");
    return cacheDevice(allDevices[0] || "");
  } catch (err) {
    logger.warn(`Device auto-detection failed: ${err.message}`);
    return "";
  }
}

// A4 by default — matches the OMR answer sheets this service scans. Without
// an explicit scan area, the ADF source on eSCL/airscan scanners defaults to
// its MAXIMUM feed length (often Legal, ~356mm) regardless of the paper
// actually loaded, leaving a tall blank strip at the bottom of the page.
// Flatbed doesn't have this problem since its default area is already close
// to A4, which is why only ADF scans show the extra space.
// Set SCAN_PAGE_WIDTH_MM/SCAN_PAGE_HEIGHT_MM to "" to disable and fall back
// to the device's default scan area.
const PAGE_WIDTH_MM = process.env.SCAN_PAGE_WIDTH_MM === "" ? null : parseFloat(process.env.SCAN_PAGE_WIDTH_MM) || 210;
const PAGE_HEIGHT_MM = process.env.SCAN_PAGE_HEIGHT_MM === "" ? null : parseFloat(process.env.SCAN_PAGE_HEIGHT_MM) || 297;

/** argv array for child: no shell quoting — each flag/value is a separate element. */
function buildSaneArgs(device, resolution) {
  const mode = process.env.SANE_MODE || "Gray";
  const args = [];
  if (device) args.push("--device-name", device);
  args.push("--mode", mode);
  if (process.env.SANE_SKIP_RESOLUTION !== "true") args.push("--resolution", String(resolution));
  if (PAGE_WIDTH_MM && PAGE_HEIGHT_MM) {
    args.push("-l", "0", "-t", "0", "-x", String(PAGE_WIDTH_MM), "-y", String(PAGE_HEIGHT_MM));
  }
  return args;
}

/** Match SANE_DEVICE env against scanimage -L output (handles index shifts and partial names). */
function matchPinnedDevice(allDevices, pinned) {
  if (!pinned) return null;
  const exact = allDevices.find((d) => d === pinned);
  if (exact) return exact;
  const prefix = allDevices.find((d) => d.startsWith(pinned));
  if (prefix) return prefix;
  const modelMatch = pinned.match(/^airscan:e\d+:(.+)$/i);
  if (modelMatch) {
    const model = modelMatch[1].toLowerCase();
    return allDevices.find((d) => {
      const m = d.match(/^airscan:e\d+:(.+)$/i);
      return m && m[1].toLowerCase().startsWith(model);
    });
  }
  return null;
}

function logArgs(cmd, args) {
  return `${cmd} ${args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")}`;
}

/** Scan straight to a PNG via argv spawn — device name never touches a shell. */
async function scanToPng(device, outputPngPath, resolution) {
  const args = [...buildSaneArgs(device, resolution), "--format", "png", "-o", outputPngPath];
  logger.info(`Executing: ${logArgs("scanimage", args)}`);
  return spawnAsync("scanimage", args);
}

// ─────────────────────────────────────────────────────────────────────────────
// BATCH SCAN — proper multi-page approach
//
// Instead of spawning a new scanimage process per page (which re-opens the
// device each time and hits airscan eSCL session conflicts), we spawn ONE
// persistent process with --batch --batch-prompt. The device is opened once
// and kept open. Each page is triggered by writing '\n' to stdin.
//
// Flow:
//   spawnBatchProcess()     → process starts, waits for first '\n'
//   triggerNextBatchPage()  → write '\n', wait for PNG file to appear
//   (repeat for each page)
//   process exits naturally after all pages
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Spawn a persistent scanimage --batch --batch-prompt process.
 * The process keeps the SANE device open for the entire session.
 * It waits for a '\n' on stdin before scanning each page.
 *
 * @param {{ device: string, sessionId: string, pageCount: number, resolution: number }} opts
 * @returns {{ child: ChildProcess, pngPaths: string[] }}
 */
function spawnBatchProcess({ device, sessionId, pageCount, resolution }) {
  // scanimage uses %d for page number in --batch pattern
  const pngPattern = path.join("/tmp", `eduscan_${sessionId}_%03d.png`);

  const args = [
    ...buildSaneArgs(device, resolution),
    "--format", "png",
    `--batch=${pngPattern}`,
    `--batch-count=${pageCount}`,
    "--batch-prompt",
  ];

  logger.info(`Spawning batch process: scanimage ${args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")}`);

  const child = spawn("scanimage", args, { stdio: ["pipe", "pipe", "pipe"] });

  child.stderr.on("data", (data) => logger.info(`[batch] ${data.toString().trim()}`));
  child.stdout.on("data", (data) => logger.info(`[batch-out] ${data.toString().trim()}`));
  child.on("error", (err) => logger.error(`Batch process error: ${err.message}`));
  child.on("close", (code) => logger.info(`Batch process exited (code ${code})`));

  // Expected PNG paths — scanimage numbers them 001, 002, ...
  const pngPaths = Array.from({ length: pageCount }, (_, i) =>
    path.join("/tmp", `eduscan_${sessionId}_${String(i + 1).padStart(3, "0")}.png`)
  );

  return { child, pngPaths };
}

/**
 * Wait for the batch process to be ready for the first page.
 * scanimage --batch-prompt prints "Place document... Press RETURN" before
 * scanning page 1 — we wait for that prompt before returning to the caller.
 * Falls back to a short fixed delay if no prompt appears (some versions differ).
 *
 * @param {ChildProcess} child
 * @returns {Promise<void>}
 */
function waitForBatchReady(child) {
  return new Promise((resolve, reject) => {
    const READY_TIMEOUT_MS = 10000;
    let settled = false;
    let lastStderr = "";

    const settle = (err) => {
      if (settled) return;
      settled = true;
      child.stderr.removeListener("data", onData);
      clearTimeout(timer);
      if (err) reject(err); else resolve();
    };

    const onData = (data) => {
      const text = data.toString();
      lastStderr = (lastStderr + text).trim();
      const lower = text.toLowerCase();
      // scanimage prints "press <return>" or "press return" when ready
      if (lower.includes("return") || lower.includes("continue") || lower.includes("place")) {
        settle(null);
      }
    };

    child.stderr.on("data", onData);

    child.once("close", (code) => {
      const detail = lastStderr || "Check scanner connection and device name.";
      if (isDeviceOpenFailure(lastStderr)) invalidateDeviceCache();
      settle(new Error(`Batch scan process exited immediately (code ${code}). ${detail}`));
    });

    // Fallback: if no prompt received within timeout, assume ready anyway
    // (some scanimage versions write to stdout or differ in wording) — but
    // only if the process is actually still running. If it already exited,
    // the "close" listener above just hasn't run yet (Node emits "exit"
    // before "close"), so treat it as the same failure it would report.
    const timer = setTimeout(() => {
      if (!settled) {
        if (child.exitCode !== null) {
          if (isDeviceOpenFailure(lastStderr)) invalidateDeviceCache();
          settle(new Error(
            `Batch process exited (code ${child.exitCode}) before readiness prompt. ` +
            `Last output: ${lastStderr || "none"}`
          ));
        } else {
          logger.warn("waitForBatchReady: readiness prompt not received — assuming ready (check scanner)");
          settle(null);
        }
      }
    }, READY_TIMEOUT_MS);
  });
}

/**
 * Trigger the next page in a batch session by writing '\n' to the process stdin,
 * then wait for the expected PNG file to be fully written to disk.
 *
 * This is the core of the proper multi-page fix: because the device is already
 * open inside the persistent process, there is no re-open, no eSCL session
 * conflict, and no airscan index staleness between pages.
 *
 * @param {ChildProcess} child    - The persistent batch process
 * @param {string}       pngPath  - Absolute path of the PNG this page should produce
 * @param {number}       timeoutMs
 * @returns {Promise<void>}
 */
function triggerNextBatchPage(child, pngPath, timeoutMs = SCAN_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.killed) {
      return reject(new Error(`Batch scan process is no longer running (code ${child.exitCode})`));
    }

    // Remove any leftover file from a previous failed attempt on this path
    try { if (fs.existsSync(pngPath)) fs.unlinkSync(pngPath); } catch (_) {}

    let settled = false;
    let pollTimer = null;

    const settle = (err) => {
      if (settled) return;
      settled = true;
      clearInterval(pollTimer);
      if (err) reject(err); else resolve();
    };

    // If the process dies before the file appears, that's an error
    child.once("close", (code) => {
      // Give a brief moment for any buffered writes to flush
      setTimeout(() => {
        if (fs.existsSync(pngPath) && fs.statSync(pngPath).size > 0) {
          settle(null);
        } else {
          settle(new Error(
            `Scan process exited (code ${code}) without producing the page image. ` +
            "Ensure a document is placed face-down on the scanner flatbed."
          ));
        }
      }, 300);
    });

    // Trigger the scan
    child.stdin.write("\n");
    logger.info(`Triggered batch page scan, waiting for: ${pngPath}`);

    // Poll for the file — scanimage writes it once the scan is complete
    const startTime = Date.now();
    pollTimer = setInterval(() => {
      try {
        if (fs.existsSync(pngPath) && fs.statSync(pngPath).size > 0) {
          settle(null);
          return;
        }
      } catch (_) {}
      if (Date.now() - startTime > timeoutMs) {
        settle(new Error(
          `Timeout: page not scanned within ${timeoutMs / 1000}s. ` +
          "Is a document placed face-down on the scanner flatbed?"
        ));
      }
    }, 500);
  });
}

/**
 * Kill a batch process cleanly. Used when cancelling a session.
 * @param {ChildProcess} child
 */
function killBatchProcess(child) {
  if (!child || child.killed || child.exitCode !== null) return;
  try {
    child.stdin.end();
    child.kill("SIGTERM");
  } catch (_) {}
}

// ─────────────────────────────────────────────────────────────────────────────
// Single-page scan (used by the legacy /api/scan endpoint, not multi-page sessions)
// ─────────────────────────────────────────────────────────────────────────────

async function scanSinglePage(pngOutputPath, resolution = 300) {
  const platform = process.platform;
  let detectedDevice = "";

  await withDeviceOpenRetry(
    async () => {
      if (platform === "win32") {
        const quoted = (p) => `"${p}"`;
        const tmpPdf = pngOutputPath.replace(/\.png$/i, ".pdf");
        const command = `${quoted(NAPS2_PATH)} -o ${quoted(tmpPdf)} --noprofile`;
        logger.info(`scanSinglePage executing: ${command}`);
        const { stdout, stderr } = await execAsync(command);
        if (stdout) logger.info(`Scanner stdout: ${stdout}`);
        if (stderr) logger.warn(`Scanner stderr: ${stderr}`);
      } else if (platform === "linux" || platform === "darwin") {
        detectedDevice = await detectLinuxDevice();
        const { stdout, stderr } = await scanToPng(detectedDevice, pngOutputPath, resolution);
        if (stdout) logger.info(`Scanner stdout: ${stdout}`);
        if (stderr) logger.warn(`Scanner stderr: ${stderr}`);
      } else {
        throw new Error(`Unsupported platform: ${platform}`);
      }
    },
    platform,
    () => detectedDevice
  );

  return { device: detectedDevice };
}

/** Recompress a scanned PNG to JPEG (same quality ImageMagick used to apply) before embedding. */
async function pngToJpegBuffer(pngPath) {
  const quality = parseInt(process.env.SCAN_QUALITY) || 82;
  return sharp(pngPath).jpeg({ quality }).toBuffer();
}

/** Embed one JPEG-compressed page into a pdf-lib document, sized to fill the page. */
async function embedPageImage(pdfDoc, pngPath) {
  const jpegBuffer = await pngToJpegBuffer(pngPath);
  const image = await pdfDoc.embedJpg(jpegBuffer);
  const page = pdfDoc.addPage([image.width, image.height]);
  page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
}

async function combinePagesToPdf(pngPaths, outputPdfPath) {
  logger.info(`Combining ${pngPaths.length} pages into PDF: ${outputPdfPath}`);
  const pdfDoc = await PDFDocument.create();
  for (const pngPath of pngPaths) {
    await embedPageImage(pdfDoc, pngPath);
  }
  fs.writeFileSync(outputPdfPath, await pdfDoc.save());
}

/** Convert a single scanned PNG into its own standalone PDF (no merge). */
async function convertPngToPdf(pngPath, outputPdfPath) {
  const pdfDoc = await PDFDocument.create();
  await embedPageImage(pdfDoc, pngPath);
  fs.writeFileSync(outputPdfPath, await pdfDoc.save());
}

/**
 * Sanity-check that a scanned page actually came back at the pinned
 * SCAN_PAGE_WIDTH_MM/HEIGHT_MM geometry. Some eSCL/airscan backends have been
 * known to silently ignore -x/-y for certain sources/firmware versions and
 * fall back to their own max scan area — this catches that early via the
 * log instead of a support ticket about "blank space at the bottom" weeks
 * later. Never throws: a dimension mismatch is logged, not fatal.
 */
async function checkPageDimensions(pngPath, resolution) {
  if (!PAGE_WIDTH_MM || !PAGE_HEIGHT_MM) return;
  try {
    const { width: actualW, height: actualH } = await sharp(pngPath).metadata();
    const expectedW = Math.round((PAGE_WIDTH_MM / 25.4) * resolution);
    const expectedH = Math.round((PAGE_HEIGHT_MM / 25.4) * resolution);
    const TOLERANCE = 0.03; // 3% — allows for scanner rounding, not real drift
    const offW = Math.abs(actualW - expectedW) / expectedW;
    const offH = Math.abs(actualH - expectedH) / expectedH;
    if (offW > TOLERANCE || offH > TOLERANCE) {
      logger.warn(
        `Scan geometry drift: ${path.basename(pngPath)} came back ${actualW}x${actualH}px, ` +
        `expected ~${expectedW}x${expectedH}px for ${PAGE_WIDTH_MM}x${PAGE_HEIGHT_MM}mm @ ${resolution}dpi. ` +
        "The scanner may be ignoring the -l/-t/-x/-y area pin — check scanimage --help -d <device> for the active source."
      );
    }
  } catch (err) {
    logger.warn(`Could not verify scan dimensions for ${pngPath}: ${err.message}`);
  }
}

/**
 * True when a scanimage error message indicates the device itself failed to
 * open (e.g. a stale cached airscan:eN index), as opposed to an unrelated
 * failure like missing paper or a missing ImageMagick policy grant. This is
 * the signal that should invalidate the cached device name so the next
 * attempt re-runs scanimage -L instead of retrying the same stale name.
 */
function isDeviceOpenFailure(message) {
  const msg = (message || "").toLowerCase();
  return (
    msg.includes("no scanners were identified") ||
    msg.includes("no sane devices found") ||
    msg.includes("failed to open device") ||
    /open of device .*failed/.test(msg)
  );
}

/**
 * Run `attempt()`; on a device-open failure, invalidate the cached device
 * name, wait AIRSCAN_RETRY_DELAY_MS (a network/airscan scanner can take a
 * moment to release a stale eSCL session from the previous attempt), and
 * retry exactly once before handing the final error to handleScanError.
 * Any other kind of failure (bad paper state, missing binary, etc.) skips
 * the wait and goes straight to handleScanError.
 *
 * @param {() => Promise<void>} attempt
 * @param {string} platform
 * @param {() => string} getDetectedDevice
 */
async function withDeviceOpenRetry(attempt, platform, getDetectedDevice) {
  try {
    await attempt();
  } catch (err) {
    if (!isDeviceOpenFailure(err.message)) {
      handleScanError(err, platform, getDetectedDevice());
      return;
    }
    invalidateDeviceCache();
    logger.warn(`Device open failed. Waiting ${AIRSCAN_RETRY_DELAY_MS}ms before retry...`);
    await sleep(AIRSCAN_RETRY_DELAY_MS);
    try {
      await attempt();
    } catch (retryErr) {
      handleScanError(retryErr, platform, getDetectedDevice());
    }
  }
}

function handleScanError(err, platform, detectedDevice) {
  logger.error(`Scan command failed: ${err.message}`);
  const msg = err.message.toLowerCase();

  if (isDeviceOpenFailure(msg)) {
    invalidateDeviceCache();
    throw new Error("Scanner not found. Ensure the scanner is connected, powered on, and the USB cable is secure.");
  }
  if (msg.includes("sane_start") && msg.includes("invalid argument")) {
    throw new Error(
      "Scanner rejected the scan request (sane_start: Invalid argument). " +
      "Most common causes: (1) no paper on the flatbed, (2) scanner is warming up — wait a moment and retry."
    );
  }
  if (msg.includes("unrecognized option") && msg.includes("resolution")) {
    throw new Error("Scanner backend does not support --resolution. Set SANE_SKIP_RESOLUTION=true in .env.");
  }
  if (msg.includes("unrecognized option") && msg.includes("mode")) {
    throw new Error(`Scanner backend does not support --mode. Check: scanimage --help -d ${detectedDevice || "<device>"}`);
  }
  if (
    msg.includes("unrecognized option") &&
    (msg.includes("'-x'") || msg.includes("'-y'") || msg.includes("'-l'") || msg.includes("'-t'"))
  ) {
    throw new Error(
      "Scanner backend does not support the -l/-t/-x/-y scan-area options. " +
      "Set SCAN_PAGE_WIDTH_MM= and SCAN_PAGE_HEIGHT_MM= (both empty) in .env to disable. " +
      `Check supported options: scanimage --help -d ${detectedDevice || "<device>"}`
    );
  }
  if (msg.includes("command not found") || msg.includes("no such file") || (msg.includes("not found") && !msg.includes("scanner"))) {
    if (platform === "win32") throw new Error(`NAPS2 not found at "${NAPS2_PATH}". Install from https://www.naps2.com`);
    if (platform === "linux") throw new Error("scanimage not found. Install: sudo apt install sane-utils");
    if (platform === "darwin") throw new Error("scanimage not found. Install: brew install sane-backends");
  }
  throw err;
}

async function executeScan({ uniqueId = null, examCode, resolution = 300 }) {
  const platform = process.platform;
  logger.info(`Scan requested — platform: ${platform}, uniqueId: ${uniqueId || "(none)"}, examCode: ${examCode}, resolution: ${resolution}`);

  const { filename, filePath } = buildOutputPath(uniqueId, examCode);
  logger.info(`Output path: ${filePath}`);

  let detectedDevice = "";

  await withDeviceOpenRetry(
    async () => {
      if (platform === "win32") {
        const quoted = (p) => `"${p}"`;
        const command = `${quoted(NAPS2_PATH)} -o ${quoted(filePath)} --noprofile`;
        logger.info(`Executing: ${command}`);
        const { stdout, stderr } = await execAsync(command);
        if (stdout) logger.info(`Scanner stdout: ${stdout}`);
        if (stderr) logger.warn(`Scanner stderr: ${stderr}`);
      } else if (platform === "linux" || platform === "darwin") {
        detectedDevice = await detectLinuxDevice();
        const tmpPng = path.join("/tmp", `scan_${Date.now()}_${process.pid}.png`);
        try {
          const { stdout, stderr } = await scanToPng(detectedDevice, tmpPng, resolution);
          if (stdout) logger.info(`Scanner stdout: ${stdout}`);
          if (stderr) logger.warn(`Scanner stderr: ${stderr}`);
          await convertPngToPdf(tmpPng, filePath);
        } finally {
          fs.unlink(tmpPng, () => {});
        }
      } else {
        throw new Error(`Unsupported platform: ${platform}`);
      }
    },
    platform,
    () => detectedDevice
  );

  if (!validateOutputFile(filePath)) {
    throw new Error("Scan command succeeded but PDF was not created or is empty. Ensure a document is placed face-down on the flatbed and retry.");
  }

  logger.info(`Scan successful: ${filename}`);
  return { success: true, filename, filePath, platform, device: detectedDevice || undefined };
}

module.exports = {
  executeScan,
  detectLinuxDevice,
  detectLinuxDeviceForced,
  invalidateDeviceCache,
  isDeviceOpenFailure,
  sleep,
  AIRSCAN_RETRY_DELAY_MS,
  buildSaneArgs,
  scanSinglePage,
  combinePagesToPdf,
  convertPngToPdf,
  checkPageDimensions,
  spawnBatchProcess,
  waitForBatchReady,
  triggerNextBatchPage,
  killBatchProcess,
};
