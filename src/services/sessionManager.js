const logger = require("../utils/logger");
const { killBatchProcess } = require("./scanService");
const { releaseScannerLock } = require("./scannerLock");
const { createOpenIndex } = require("./crashRecovery");
const { generateId, cleanupFiles } = require("../../shared/utils");

const SESSION_TIMEOUT_MS =
  parseInt(process.env.SCAN_SESSION_TIMEOUT_MS) || 30 * 60 * 1000; // 30 min

const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 min

/** @type {Map<string, ScanSession>} */
const sessions = new Map();

// Crash/restart recovery — see crashRecovery.js for why this is cleanup-only
// and never resumes a session.
const sessionIndex = createOpenIndex(".sessions-open.json", (id) => `eduscan_${id}_`);
sessionIndex.recoverOrphaned();

/**
 * @typedef {Object} ScanSession
 * @property {string}        id
 * @property {string|null}   uniqueId
 * @property {string}        examCode
 * @property {number}        resolution
 * @property {number}        totalPages
 * @property {string[]}      scannedPages   - absolute paths to temp PNG files
 * @property {string[]}      batchPngPaths  - pre-computed PNG paths for the batch process
 * @property {import("child_process").ChildProcess|null} batchProcess - persistent scanimage process
 * @property {"active"|"completing"|"completed"|"cancelled"} status
 * @property {string}        platform
 * @property {string}        device
 * @property {number}        createdAt
 */

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
    batchPngPaths: [],
    batchProcess: null,
    status: "active",
    platform: process.platform,
    device: "",
    createdAt: Date.now(),
  };
  sessions.set(session.id, session);
  sessionIndex.markOpen(session.id);
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
 * Remove temp PNG files and kill the batch process for a session.
 * @param {ScanSession} session
 */
function cleanupTempFiles(session) {
  // Kill the persistent batch process first so it releases file handles
  if (session.batchProcess) {
    killBatchProcess(session.batchProcess);
    session.batchProcess = null;
  }

  // Release the scanner mutex acquired at /scan/start. No-op if this session
  // never held it (e.g. Windows sessions, which lock per-page instead).
  releaseScannerLock(session.id);

  // Clean up all temp PNGs — both already-scanned pages and pre-computed paths
  const allPaths = new Set([...session.scannedPages, ...session.batchPngPaths]);
  cleanupFiles([...allPaths]);
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
  sessionIndex.markClosed(id);
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
