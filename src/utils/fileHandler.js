const fs = require("fs");
const path = require("path");
const logger = require("./logger");

// Root scans directory — configurable via env, defaults to /scans in project root
const SCANS_DIR = process.env.SCANS_DIR
  ? path.resolve(process.env.SCANS_DIR)
  : path.join(__dirname, "../../scans");

/**
 * Ensure the root scans directory exists.
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
 * Sanitise a string for use as a folder or filename component.
 * Replaces any character that is not alphanumeric, underscore, or hyphen with _.
 */
function sanitize(str) {
  return String(str).replace(/[^a-zA-Z0-9_\-]/g, "_");
}

/**
 * Build the output file path for a scanned PDF.
 * PDFs are saved inside a per-exam subfolder:
 *   scans/<examCode>/<uniqueId>_<examCode>_<timestamp>.pdf  (when uniqueId provided)
 *   scans/<examCode>/<examCode>_<timestamp>.pdf             (when uniqueId omitted)
 *
 * @param {string|null|undefined} uniqueId - Optional identifier (roll number, center ID, etc.)
 * @param {string} examCode
 * @returns {{ filename: string, filePath: string, examDir: string }}
 */
function buildOutputPath(uniqueId, examCode) {
  ensureScansDirectory();

  const safeExam = sanitize(examCode);
  const examDir = path.join(SCANS_DIR, safeExam);

  if (!fs.existsSync(examDir)) {
    fs.mkdirSync(examDir, { recursive: true });
    logger.info(`Created exam folder: ${examDir}`);
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const prefix = uniqueId && String(uniqueId).trim() ? `${sanitize(String(uniqueId).trim())}_` : "";
  const filename = `${prefix}${safeExam}_${timestamp}.pdf`;
  const filePath = path.join(examDir, filename);

  return { filename, filePath, examDir };
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

/**
 * List all exam-code subfolders under SCANS_DIR.
 * Each subfolder name is the sanitised examCode used when scanning.
 *
 * @returns {Array<{ examCode: string, fileCount: number, dirPath: string }>}
 */
function listExamFolders() {
  ensureScansDirectory();

  const entries = fs.readdirSync(SCANS_DIR, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((dir) => {
      const dirPath = path.join(SCANS_DIR, dir.name);
      const files = fs.readdirSync(dirPath).filter((f) => f.endsWith(".pdf"));
      return { examCode: dir.name, fileCount: files.length, dirPath };
    });
}

/**
 * List all PDF files inside a specific exam's subfolder.
 *
 * @param {string} examCode
 * @returns {Array<{ filename: string, size: number, createdAt: string }>}
 *          or null if the exam folder does not exist
 */
function listDocsForExam(examCode) {
  const safeExam = sanitize(examCode);
  const examDir = path.join(SCANS_DIR, safeExam);

  if (!fs.existsSync(examDir)) return null;

  const files = fs.readdirSync(examDir).filter((f) => f.endsWith(".pdf"));
  return files.map((filename) => {
    const filePath = path.join(examDir, filename);
    const stat = fs.statSync(filePath);
    return {
      filename,
      size: stat.size,
      createdAt: stat.birthtime.toISOString(),
    };
  });
}

/**
 * Delete specific PDF files from an exam's scan folder.
 *
 * @param {string} examCode
 * @param {string[]} filenames  - Array of filenames to delete (e.g. ["roll1_EXAM_2026.pdf"])
 * @returns {{ deleted: string[], notFound: string[], errors: string[] }}
 */
function deleteDocuments(examCode, filenames) {
  const safeExam = sanitize(examCode);
  const examDir = path.join(SCANS_DIR, safeExam);

  if (!fs.existsSync(examDir)) {
    return { deleted: [], notFound: filenames, errors: [] };
  }

  const deleted = [];
  const notFound = [];
  const errors = [];

  for (const filename of filenames) {
    // Strip any path separators to prevent directory traversal
    const safeFilename = path.basename(filename);

    if (!safeFilename.endsWith(".pdf")) {
      errors.push(`${safeFilename}: only PDF files can be deleted`);
      continue;
    }

    const filePath = path.join(examDir, safeFilename);

    if (!fs.existsSync(filePath)) {
      notFound.push(safeFilename);
      continue;
    }

    try {
      fs.unlinkSync(filePath);
      deleted.push(safeFilename);
      logger.info(`Deleted scanned file: ${filePath}`);
    } catch (err) {
      logger.error(`Failed to delete ${filePath}: ${err.message}`);
      errors.push(`${safeFilename}: ${err.message}`);
    }
  }

  return { deleted, notFound, errors };
}

module.exports = {
  ensureScansDirectory,
  buildOutputPath,
  validateOutputFile,
  listExamFolders,
  listDocsForExam,
  deleteDocuments,
  sanitize,
  SCANS_DIR,
};
