const { exec, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const logger = require("../utils/logger");
const { buildOutputPath, validateOutputFile } = require("../utils/fileHandler");

const SCAN_TIMEOUT_MS = parseInt(process.env.SCAN_TIMEOUT_MS) || 60000;

const NAPS2_PATH =
  process.env.NAPS2_PATH ||
  "C:\\Program Files\\NAPS2\\naps2.console.exe";

let IM_COMMAND = "convert";

function detectImageMagick() {
  exec("magick -version", (error) => {
    if (!error) {
      IM_COMMAND = "magick";
      logger.info("ImageMagick 7+ detected, using 'magick' command.");
    } else {
      IM_COMMAND = "convert";
      logger.info("ImageMagick 6 or older detected, using 'convert' command.");
    }
  });
}
detectImageMagick();

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

/**
 * Always runs scanimage -L regardless of SANE_DEVICE env.
 * Call this to get a fresh device name after a scan — the airscan:eN
 * positional index can shift after the scanner re-advertises via mDNS.
 */
async function detectLinuxDeviceForced() {
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
        return matched;
      }
      logger.warn(`SANE_DEVICE "${pinned}" not found in scanimage -L output`);
    }

    const preferred = allDevices.find((d) => d.startsWith("pixma:") || d.toLowerCase().includes("canon"));
    if (preferred) { logger.info(`Auto-selected device: ${preferred}`); return preferred; }

    const nonWebcam = allDevices.find((d) => !d.startsWith("v4l:"));
    if (nonWebcam) { logger.info(`Auto-selected non-webcam device: ${nonWebcam}`); return nonWebcam; }

    logger.warn("Only webcam (v4l) devices found — scan may fail");
    return allDevices[0] || "";
  } catch (err) {
    logger.warn(`Device auto-detection failed: ${err.message}`);
    return "";
  }
}

function imgToPdfCmd(src, dest) {
  const quality = parseInt(process.env.SCAN_QUALITY) || 82;
  return `${IM_COMMAND} -compress jpeg -quality ${quality} ${src} ${dest}`;
}

function buildSaneFlags(device, resolution) {
  const deviceFlag = device ? `--device-name="${device}"` : "";
  const resolutionFlag = process.env.SANE_SKIP_RESOLUTION === "true" ? "" : `--resolution=${resolution}`;
  const modeFlag = `--mode=${process.env.SANE_MODE || "Gray"}`;
  return { deviceFlag, modeFlag, resolutionFlag };
}

/** argv array for child: no shell quoting — each flag/value is a separate element. */
function buildSaneArgs(device, resolution) {
  const mode = process.env.SANE_MODE || "Gray";
  const args = [];
  if (device) args.push("--device-name", device);
  args.push("--mode", mode);
  if (process.env.SANE_SKIP_RESOLUTION !== "true") args.push("--resolution", String(resolution));
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

function buildLinuxScanCommand(device, outputPath, resolution) {
  const quoted = (p) => `"${p}"`;
  const tmpPng = quoted(path.join("/tmp", `scan_${Date.now()}.png`));
  const { deviceFlag, modeFlag, resolutionFlag } = buildSaneFlags(device, resolution);
  const scanCmd = `scanimage ${deviceFlag} ${modeFlag} ${resolutionFlag} --format=png -o ${tmpPng}`.replace(/\s+/g, " ").trim();
  return `${scanCmd} && ${imgToPdfCmd(tmpPng, quoted(outputPath))} && rm -f ${tmpPng}`;
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
      settle(new Error(`Batch scan process exited immediately (code ${code}). ${detail}`));
    });

    // Fallback: if no prompt received within timeout, assume ready anyway
    // (some scanimage versions write to stdout or differ in wording)
    const timer = setTimeout(() => {
      if (!settled) {
        logger.warn("waitForBatchReady: no prompt received, assuming process is ready");
        settle(null);
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
  let command;
  let detectedDevice = "";

  if (platform === "win32") {
    const quoted = (p) => `"${p}"`;
    const tmpPdf = pngOutputPath.replace(/\.png$/i, ".pdf");
    command = `${quoted(NAPS2_PATH)} -o ${quoted(tmpPdf)} --noprofile`;
  } else if (platform === "linux" || platform === "darwin") {
    detectedDevice = await detectLinuxDevice();
    const { deviceFlag, modeFlag, resolutionFlag } = buildSaneFlags(detectedDevice, resolution);
    command = `scanimage ${deviceFlag} ${modeFlag} ${resolutionFlag} --format=png -o "${pngOutputPath}"`.replace(/\s+/g, " ").trim();
  } else {
    throw new Error(`Unsupported platform: ${platform}`);
  }

  logger.info(`scanSinglePage executing: ${command}`);

  try {
    const { stdout, stderr } = await execAsync(command);
    if (stdout) logger.info(`Scanner stdout: ${stdout}`);
    if (stderr) logger.warn(`Scanner stderr: ${stderr}`);
  } catch (err) {
    handleScanError(err, platform, detectedDevice);
  }

  return { device: detectedDevice };
}

async function combinePagesToPdf(pngPaths, outputPdfPath) {
  const quoted = (p) => `"${p}"`;
  const quality = parseInt(process.env.SCAN_QUALITY) || 82;
  const sources = pngPaths.map((p) => quoted(p)).join(" ");
  const cmd = `${IM_COMMAND} -compress jpeg -quality ${quality} ${sources} ${quoted(outputPdfPath)}`;
  logger.info(`Combining ${pngPaths.length} pages into PDF: ${outputPdfPath}`);
  await execAsync(cmd);
}

/** Convert a single scanned PNG into its own standalone PDF (no merge). */
async function convertPngToPdf(pngPath, outputPdfPath) {
  const quoted = (p) => `"${p}"`;
  await execAsync(imgToPdfCmd(quoted(pngPath), quoted(outputPdfPath)));
}

function handleScanError(err, platform, detectedDevice) {
  logger.error(`Scan command failed: ${err.message}`);
  const msg = err.message.toLowerCase();

  if (msg.includes("no scanners were identified") || msg.includes("failed to open device")) {
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
  if (msg.includes("not authorized") || (msg.includes("policy") && msg.includes("pdf"))) {
    throw new Error(
      "ImageMagick security policy is blocking PDF conversion. " +
      "Fix: sudo sed -i 's/rights=\"none\" pattern=\"PDF\"/rights=\"read|write\" pattern=\"PDF\"/' /etc/ImageMagick-6/policy.xml"
    );
  }
  if (msg.includes("command not found") || msg.includes("no such file") || (msg.includes("not found") && !msg.includes("scanner"))) {
    if (platform === "win32") throw new Error(`NAPS2 not found at "${NAPS2_PATH}". Install from https://www.naps2.com`);
    if (platform === "linux") throw new Error(`scanimage or ImageMagick (${IM_COMMAND}) not found. Install: sudo apt install sane-utils imagemagick`);
    if (platform === "darwin") throw new Error("scanimage or ImageMagick not found. Install: brew install sane-backends imagemagick");
  }
  throw err;
}

async function executeScan({ uniqueId = null, examCode, resolution = 300 }) {
  const platform = process.platform;
  logger.info(`Scan requested — platform: ${platform}, uniqueId: ${uniqueId || "(none)"}, examCode: ${examCode}, resolution: ${resolution}`);

  const { filename, filePath } = buildOutputPath(uniqueId, examCode);
  logger.info(`Output path: ${filePath}`);

  let command;
  let detectedDevice = "";

  if (platform === "win32") {
    const quoted = (p) => `"${p}"`;
    command = `${quoted(NAPS2_PATH)} -o ${quoted(filePath)} --noprofile`;
  } else if (platform === "linux" || platform === "darwin") {
    detectedDevice = await detectLinuxDevice();
    command = buildLinuxScanCommand(detectedDevice, filePath, resolution);
  } else {
    throw new Error(`Unsupported platform: ${platform}`);
  }

  logger.info(`Executing: ${command}`);

  try {
    const { stdout, stderr } = await execAsync(command);
    if (stdout) logger.info(`Scanner stdout: ${stdout}`);
    if (stderr) logger.warn(`Scanner stderr: ${stderr}`);
  } catch (err) {
    handleScanError(err, platform, detectedDevice);
  }

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
  buildSaneArgs,
  scanSinglePage,
  combinePagesToPdf,
  convertPngToPdf,
  spawnBatchProcess,
  waitForBatchReady,
  triggerNextBatchPage,
  killBatchProcess,
};
