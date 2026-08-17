const express = require("express");
const path = require("path");
const { listExamFolders, listDocsForExam, deleteDocuments, sanitize, SCANS_DIR } = require("../utils/fileHandler");
const logger = require("../utils/logger");

const router = express.Router();

// Base URL used to build previewUrl values in list responses.
// Reads from env so it works if the service is ever exposed beyond localhost.
const SERVICE_BASE = process.env.SERVICE_BASE_URL || "http://localhost:4545";

/**
 * @openapi
 * /api/docs:
 *   get:
 *     tags: [Documents]
 *     summary: List all exam folders with scanned documents
 *     responses:
 *       200:
 *         description: Exam folders
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ExamFolderListResponse' }
 *       500:
 *         description: Failed to list exam folders
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
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
 * @openapi
 * /api/docs/{examCode}:
 *   get:
 *     tags: [Documents]
 *     summary: List scanned PDFs for an exam
 *     parameters:
 *       - in: path
 *         name: examCode
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Documents for this exam
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ExamDocumentListResponse' }
 *       400:
 *         description: examCode is required
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 *       404:
 *         description: No scan folder found for this exam yet
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 *       500:
 *         description: Failed to list documents
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
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
 * @openapi
 * /api/docs/{examCode}/{filename}:
 *   get:
 *     tags: [Documents]
 *     summary: Preview/download a scanned PDF
 *     description: Streams a specific scanned PDF file for in-browser preview. The browser displays the PDF inline using its native PDF viewer. No authentication required — intended for local network use only. Only .pdf files are served; other extensions are rejected.
 *     parameters:
 *       - in: path
 *         name: examCode
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: filename
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: PDF file bytes
 *         content:
 *           application/pdf:
 *             schema: { type: string, format: binary }
 *       400:
 *         description: Missing examCode/filename, or filename is not a .pdf
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 *       404:
 *         description: Document not found
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 *       500:
 *         description: Failed to serve document
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
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
 * @openapi
 * /api/docs/{examCode}:
 *   delete:
 *     tags: [Documents]
 *     summary: Delete scanned PDF files for an exam
 *     description: Deletes one or more scanned PDF files that have been successfully uploaded to the backend pipeline. Called by the admin frontend after a confirmed upload.
 *     parameters:
 *       - in: path
 *         name: examCode
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [filenames]
 *             properties:
 *               filenames:
 *                 type: array
 *                 items: { type: string }
 *                 example: ["roll1_EXAM_2026-04-02T12-00-00.pdf"]
 *     responses:
 *       200:
 *         description: Deletion result
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/DeleteDocsResponse' }
 *       400:
 *         description: Missing examCode, or filenames is missing/empty
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 *       500:
 *         description: Failed to delete documents
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
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
