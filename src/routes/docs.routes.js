const express = require("express");
const path = require("path");
const { listExamFolders, listDocsForExam, deleteDocuments, sanitize, SCANS_DIR } = require("../utils/fileHandler");
const logger = require("../utils/logger");

const router = express.Router();

// Base URL used to build previewUrl values in list responses.
// Reads from env so it works if the service is ever exposed beyond localhost.
const SERVICE_BASE = process.env.SERVICE_BASE_URL || "http://localhost:4545";

/**
 * GET /api/docs
 *
 * List all exam folders that contain scanned documents.
 *
 * Response 200:
 *   {
 *     success: true,
 *     exams: [{ examCode, fileCount }]
 *   }
 */
router.get("/docs", (req, res) => {
  try {
    const folders = listExamFolders();
    logger.info(`Listed ${folders.length} exam folder(s)`);
    return res.json({
      success: true,
      exams: folders.map(({ examCode, fileCount }) => ({ examCode, fileCount })),
    });
  } catch (err) {
    logger.error(`Failed to list exam folders: ${err.message}`);
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/docs/:examCode
 *
 * List all scanned PDFs for a given exam.
 *
 * Response 200:
 *   {
 *     success: true,
 *     examCode: "MATH2026",
 *     documents: [
 *       { filename, size, createdAt, previewUrl }
 *     ]
 *   }
 *
 * Response 404 — exam folder does not exist yet (no scans for this exam).
 */
router.get("/docs/:examCode", (req, res) => {
  const { examCode } = req.params;

  if (!examCode || !examCode.trim()) {
    return res.status(400).json({ success: false, message: "examCode is required" });
  }

  try {
    const docs = listDocsForExam(examCode.trim());

    if (docs === null) {
      return res.status(404).json({
        success: false,
        message: `No scan folder found for exam: ${examCode}. No documents have been scanned for this exam yet.`,
      });
    }

    const documents = docs.map((doc) => ({
      ...doc,
      previewUrl: `${SERVICE_BASE}/api/docs/${encodeURIComponent(sanitize(examCode))}/${encodeURIComponent(doc.filename)}`,
    }));

    logger.info(`Listed ${documents.length} document(s) for exam: ${examCode}`);
    return res.json({
      success: true,
      examCode: sanitize(examCode),
      documentCount: documents.length,
      documents,
    });
  } catch (err) {
    logger.error(`Failed to list docs for exam ${examCode}: ${err.message}`);
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/docs/:examCode/:filename
 *
 * Stream a specific scanned PDF file for in-browser preview.
 * The browser will display the PDF inline using its native PDF viewer.
 * No authentication required — intended for local network use only.
 *
 * Response: PDF bytes with Content-Type: application/pdf
 * Response 404: file or exam folder not found
 */
router.get("/docs/:examCode/:filename", (req, res) => {
  const { examCode, filename } = req.params;

  if (!examCode || !filename) {
    return res.status(400).json({ success: false, message: "examCode and filename are required" });
  }

  // Sanitise both path components to prevent directory traversal attacks
  const safeExam = sanitize(examCode);
  const safeFilename = path.basename(filename); // strip any path separators

  // Only allow .pdf files
  if (!safeFilename.endsWith(".pdf")) {
    return res.status(400).json({ success: false, message: "Only PDF files can be served" });
  }

  const filePath = path.join(SCANS_DIR, safeExam, safeFilename);

  logger.info(`Preview request: ${filePath}`);

  res.sendFile(filePath, (err) => {
    if (err) {
      if (err.code === "ENOENT") {
        logger.warn(`File not found: ${filePath}`);
        return res.status(404).json({
          success: false,
          message: `Document not found: ${safeFilename} in exam ${safeExam}`,
        });
      }
      logger.error(`Failed to send file ${filePath}: ${err.message}`);
      return res.status(500).json({ success: false, message: "Failed to serve document" });
    }
    logger.info(`Served: ${safeFilename}`);
  });
});

/**
 * DELETE /api/docs/:examCode
 *
 * Delete one or more scanned PDF files that have been successfully uploaded
 * to the backend pipeline. Called by the admin frontend after a confirmed upload.
 *
 * Body (JSON):
 *   { filenames: ["roll1_EXAM_2026-04-02T12-00-00.pdf", ...] }
 *
 * Response 200:
 *   { success: true, deleted: [...], notFound: [...], errors: [...] }
 *
 * Response 400: missing / invalid body
 * Response 404: exam folder does not exist
 */
router.delete("/docs/:examCode", (req, res) => {
  const { examCode } = req.params;
  const { filenames } = req.body || {};

  if (!examCode || !examCode.trim()) {
    return res.status(400).json({ success: false, message: "examCode is required" });
  }

  if (!Array.isArray(filenames) || filenames.length === 0) {
    return res.status(400).json({
      success: false,
      message: "Body must include a non-empty 'filenames' array",
    });
  }

  try {
    const result = deleteDocuments(examCode.trim(), filenames);

    logger.info(
      `Delete request for exam ${examCode}: ` +
        `deleted=${result.deleted.length}, notFound=${result.notFound.length}, errors=${result.errors.length}`
    );

    return res.json({
      success: true,
      deleted: result.deleted,
      notFound: result.notFound,
      errors: result.errors,
      message: `${result.deleted.length} file(s) deleted successfully`,
    });
  } catch (err) {
    logger.error(`Failed to delete docs for exam ${examCode}: ${err.message}`);
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
