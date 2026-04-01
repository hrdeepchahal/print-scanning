const fs = require("fs");
const path = require("path");
const logger = require("./logger");

// Scans output directory — configurable via env, defaults to /scans in project root
const SCANS_DIR = process.env.SCANS_DIR
  ? path.resolve(process.env.SCANS_DIR)
  : path.join(__dirname, "../../scans");

/**
 * Ensure the scans output directory exists.
 * Creates it (and any parent directories) if missing.
 */
function ensureScansDirectory() {
  if (!fs.existsSync(SCANS_DIR)) {
    fs.mkdirSync(SCANS_DIR, { recursive: true });
    logger.info(`Created scans directory: ${SCANS_DIR}`);
  }
  return SCANS_DIR;
}

/**
 * Build a sanitised output file path for the scanned PDF.
 *
 * @param {string} rollNumber - Student roll number
 * @param {string} examCode   - Exam code
 * @returns {{ filename: string, filePath: string }}
 */
function buildOutputPath(rollNumber, examCode) {
  const sanitize = (str) => String(str).replace(/[^a-zA-Z0-9_\-]/g, "_");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `${sanitize(rollNumber)}_${sanitize(examCode)}_${timestamp}.pdf`;
  const filePath = path.join(ensureScansDirectory(), filename);
  return { filename, filePath };
}

/**
 * Verify a file exists at the given path and has non-zero size.
 *
 * @param {string} filePath
 * @returns {boolean}
 */
function validateOutputFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

module.exports = { ensureScansDirectory, buildOutputPath, validateOutputFile, SCANS_DIR };
