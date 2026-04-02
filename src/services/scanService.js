const { exec } = require("child_process");
const path = require("path");
const logger = require("../utils/logger");
const { buildOutputPath, validateOutputFile } = require("../utils/fileHandler");

// Default scan timeout: 60 seconds (scanners can be slow to warm up)
const SCAN_TIMEOUT_MS = parseInt(process.env.SCAN_TIMEOUT_MS) || 60000;

// NAPS2 CLI executable path on Windows — override via env if installed elsewhere
const NAPS2_PATH =
  process.env.NAPS2_PATH ||
  "C:\\Program Files\\NAPS2\\naps2.console.exe";

/**
 * Wrap child_process.exec in a Promise with a configurable timeout.
 *
 * @param {string} command
 * @param {number} timeoutMs
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
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

    child.on("error", (err) => {
      reject(new Error(`Failed to launch scan command: ${err.message}`));
    });
  });
}

/**
 * Auto-detect the best SANE scanner device on Linux by running `scanimage -L`
 * and returning the first non-webcam (non-v4l) device found.
 *
 * Without a pinned device, `scanimage` picks the first listed device —
 * which is often a webcam (v4l backend) that doesn't support scanner options
 * like --resolution, causing "unrecognized option" errors.
 *
 * Priority order:
 *   1. SANE_DEVICE env var (explicit admin override)
 *   2. First pixma / canon device
 *   3. First non-v4l device
 *   4. Empty string (let SANE pick — last resort)
 *
 * @returns {Promise<string>} device name, e.g. "pixma:04A92759_01E3B00006EC"
 */
async function detectLinuxDevice() {
  // Admin has pinned a device — trust it unconditionally
  if (process.env.SANE_DEVICE) {
    logger.info(`Using pinned SANE_DEVICE: ${process.env.SANE_DEVICE}`);
    return process.env.SANE_DEVICE;
  }

  try {
    const { stdout } = await execAsync("scanimage -L 2>/dev/null", 15000);
    if (!stdout) {
      logger.warn("scanimage -L returned no output — no scanner detected");
      return "";
    }

    // Each line looks like: device `name' is a Description
    const deviceLines = stdout.split("\n").filter((l) => l.includes("device `"));
    const extractName = (line) => {
      const m = line.match(/device `([^']+)'/);
      return m ? m[1] : null;
    };

    const allDevices = deviceLines.map(extractName).filter(Boolean);
    logger.info(`Detected SANE devices: ${allDevices.join(", ")}`);

    // Prefer pixma/canon devices first
    const preferred = allDevices.find(
      (d) => d.startsWith("pixma:") || d.toLowerCase().includes("canon")
    );
    if (preferred) {
      logger.info(`Auto-selected device: ${preferred}`);
      return preferred;
    }

    // Fall back to first non-v4l device
    const nonWebcam = allDevices.find((d) => !d.startsWith("v4l:"));
    if (nonWebcam) {
      logger.info(`Auto-selected non-webcam device: ${nonWebcam}`);
      return nonWebcam;
    }

    logger.warn("Only webcam (v4l) devices found — scan may fail");
    return allDevices[0] || "";
  } catch (err) {
    logger.warn(`Device auto-detection failed: ${err.message}`);
    return "";
  }
}

/**
 * Return a shell snippet that converts an image file to PDF, trying
 * `convert` (ImageMagick <=6) first and `magick` (ImageMagick >=7) as a
 * fallback. Both are tried so the service works on all distros regardless
 * of which ImageMagick version is installed.
 *
 * @param {string} src  - quoted source image path
 * @param {string} dest - quoted destination PDF path
 * @returns {string}
 */
function imgToPdfCmd(src, dest) {
  return `(convert ${src} ${dest} 2>/dev/null || magick ${src} ${dest})`;
}

/**
 * Build the Linux-specific scanimage command.
 *
 * @param {string} device     - SANE device string (e.g. "pixma:04A92759_01E3B00006EC")
 * @param {string} outputPath - Absolute path for the output PDF
 * @param {number} resolution - DPI
 * @returns {string} shell command
 */
function buildLinuxScanCommand(device, outputPath, resolution) {
  const quoted = (p) => `"${p}"`;
  const tmpPng = quoted(path.join("/tmp", `scan_${Date.now()}.png`));

  const deviceFlag = device ? `--device-name=${quoted(device)}` : "";

  // --resolution is supported by the pixma backend (confirmed via scanimage --help).
  // v4l (webcam) devices do NOT support it, which is why auto-detection above
  // avoids them. If an unrecognized-option error still occurs for a custom backend,
  // set SANE_SKIP_RESOLUTION=true in .env to omit the flag.
  const resolutionFlag =
    process.env.SANE_SKIP_RESOLUTION === "true" ? "" : `--resolution=${resolution}`;

  // Scan mode: default Gray for document scanning (smaller file, faster).
  // Override with SANE_MODE=Color in .env for colour documents.
  const scanMode = process.env.SANE_MODE || "Gray";
  const modeFlag = `--mode=${scanMode}`;

  const scanCmd = `scanimage ${deviceFlag} ${modeFlag} ${resolutionFlag} --format=png -o ${tmpPng}`
    .replace(/\s+/g, " ")
    .trim();

  const convertCmd = imgToPdfCmd(tmpPng, quoted(outputPath));
  const cleanupCmd = `rm -f ${tmpPng}`;

  return `${scanCmd} && ${convertCmd} && ${cleanupCmd}`;
}

/**
 * Execute a document scan for the given student/exam context.
 *
 * @param {object} options
 * @param {string} options.rollNumber  - Student roll number (used in filename)
 * @param {string} options.examCode    - Exam code (used in filename)
 * @param {number} [options.resolution=300] - Scan resolution in DPI
 * @returns {Promise<{ success: boolean, filename: string, filePath: string, platform: string, device?: string }>}
 */
async function executeScan({ rollNumber, examCode, resolution = 300 }) {
  const platform = process.platform;
  logger.info(
    `Scan requested — platform: ${platform}, rollNumber: ${rollNumber}, ` +
    `examCode: ${examCode}, resolution: ${resolution}`
  );

  const { filename, filePath } = buildOutputPath(rollNumber, examCode);
  logger.info(`Output path: ${filePath}`);

  let command;
  let detectedDevice = "";

  if (platform === "win32") {
    const quoted = (p) => `"${p}"`;
    command = `${quoted(NAPS2_PATH)} -o ${quoted(filePath)} --noprofile`;

  } else if (platform === "linux") {
    detectedDevice = await detectLinuxDevice();
    command = buildLinuxScanCommand(detectedDevice, filePath, resolution);

  } else if (platform === "darwin") {
    // macOS uses SANE (scanimage) — same as Linux — for real scanners like Canon MF3010.
    // Install: brew install sane-backends imagemagick
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
    logger.error(`Scan command failed: ${err.message}`);
    const msg = err.message.toLowerCase();

    if (msg.includes("no scanners were identified") || msg.includes("failed to open device")) {
      throw new Error(
        "Scanner not found. Ensure the Canon MF3010 is connected, powered on, and USB cable is secure."
      );
    }
    if (msg.includes("sane_start") && msg.includes("invalid argument")) {
      throw new Error(
        "Scanner rejected the scan request (sane_start: Invalid argument). " +
        "Most common causes: (1) no paper on the flatbed, (2) scanner is warming up — wait a moment and retry, " +
        "(3) run 'scanimage --help' to check supported modes for your device."
      );
    }
    if (msg.includes("unrecognized option") && msg.includes("resolution")) {
      throw new Error(
        "Scanner backend does not support --resolution. " +
        "Set SANE_SKIP_RESOLUTION=true in .env to disable it."
      );
    }
    if (msg.includes("unrecognized option") && msg.includes("mode")) {
      throw new Error(
        "Scanner backend does not support --mode. " +
        "Check supported options with: scanimage --help -d " + (detectedDevice || "<device>")
      );
    }
    if (
      msg.includes("command not found") ||
      msg.includes("no such file") ||
      (msg.includes("not found") && !msg.includes("scanner"))
    ) {
      if (platform === "win32") {
        throw new Error(
          `NAPS2 not found at "${NAPS2_PATH}". ` +
          "Install NAPS2 from https://www.naps2.com or set NAPS2_PATH env variable."
        );
      }
      if (platform === "linux") {
        throw new Error(
          "scanimage or ImageMagick not found. " +
          "Install: sudo apt install sane-utils imagemagick"
        );
      }
      if (platform === "darwin") {
        throw new Error(
          "scanimage or ImageMagick not found on macOS. " +
          "Install: brew install sane-backends imagemagick"
        );
      }
    }
    throw err;
  }

  if (!validateOutputFile(filePath)) {
    throw new Error(
      "Scan command succeeded but PDF was not created or is empty. " +
      "Ensure a document is placed face-down on the flatbed and retry."
    );
  }

  logger.info(`Scan successful: ${filename}`);
  return { success: true, filename, filePath, platform, device: detectedDevice || undefined };
}

module.exports = { executeScan, detectLinuxDevice };
