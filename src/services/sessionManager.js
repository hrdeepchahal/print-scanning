const crypto = require("crypto");
const fs = require("fs");
const logger = require("../utils/logger");

const SESSION_TIMEOUT_MS =
  parseInt(process.env.SCAN_SESSION_TIMEOUT_MS) || 30 * 60 * 1000; // 30 min

const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 min

/** @type {Map<string, ScanSession>} */
const sessions = new Map();

/**
 * @typedef {Object} ScanSession
 * @property {string}        id
 * @property {string|null}   uniqueId      - Optional identifier (roll number, center ID, etc.)
 * @property {string}        examCode
 * @property {number}        resolution
 * @property {number}        totalPages
 * @property {string[]}      scannedPages  - absolute paths to temp PNG files
 * @property {"active"|"completing"|"completed"|"cancelled"} status
 * @property {string}        platform
 * @property {string}        device
 * @property {number}        createdAt     - Date.now()
 */

function generateId() {
  return crypto.randomBytes(12).toString("hex");
}

/**
 * Create a new multi-page scan session.
 *
 * @param {{ uniqueId?: string|null, examCode: string, totalPages: number, resolution?: number }} opts
 * @returns {ScanSession}
 */
function createSession({ uniqueId = null, examCode, totalPages, resolution = 300 }) {
  const session = {
    id: generateId(),
    uniqueId,
    examCode,
    resolution,
    totalPages,
    scannedPages: [],
    status: "active",
    platform: process.platform,
    device: "",
    createdAt: Date.now(),
  };
  sessions.set(session.id, session);
  logger.info(
    `Scan session created: ${session.id} — ${totalPages} page(s), uniqueId: ${uniqueId || "(none)"}, exam: ${examCode}`
  );
  return session;
}

/**
 * @param {string} id
 * @returns {ScanSession|undefined}
 */
function getSession(id) {
  return sessions.get(id);
}

/**
 * Remove temp PNG files associated with a session.
 * @param {ScanSession} session
 */
function cleanupTempFiles(session) {
  for (const filePath of session.scannedPages) {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        logger.info(`Cleaned up temp file: ${filePath}`);
      }
    } catch (err) {
      logger.warn(`Failed to clean up ${filePath}: ${err.message}`);
    }
  }
}

/**
 * Remove a session and optionally clean up its temp files.
 * @param {string} id
 * @param {boolean} [cleanup=true]
 */
function removeSession(id, cleanup = true) {
  const session = sessions.get(id);
  if (!session) return;
  if (cleanup) cleanupTempFiles(session);
  sessions.delete(id);
  logger.info(`Session removed: ${id}`);
}

/**
 * Purge sessions that have exceeded the timeout.
 * Called periodically by the cleanup interval.
 */
function purgeExpiredSessions() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.createdAt > SESSION_TIMEOUT_MS) {
      logger.warn(`Purging expired session: ${id} (age: ${Math.round((now - session.createdAt) / 1000)}s)`);
      session.status = "cancelled";
      removeSession(id, true);
    }
  }
}

const cleanupTimer = setInterval(purgeExpiredSessions, CLEANUP_INTERVAL_MS);
cleanupTimer.unref();

module.exports = {
  createSession,
  getSession,
  removeSession,
  cleanupTempFiles,
  sessions,
};
