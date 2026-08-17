const fs = require("fs");
const path = require("path");
const logger = require("../utils/logger");
const { ensureScansDirectory, SCANS_DIR } = require("../utils/fileHandler");
const { getTempDir } = require("../../shared/platform");

/*
 * Scan sessions and auto-scan jobs both hold a live scanimage child process
 * open for their whole lifetime. That process can't survive a service
 * restart — it's either already dead, or an orphan still holding the
 * physical device with nothing left tracking it (scannerLock.js's mutex is
 * in-memory too, so it resets right along with everything else). Silently
 * "resuming" a session/job post-restart would mean falling back to a
 * different scan mechanism while a now-invisible orphaned process might
 * still be holding the device — recreating the exact hardware conflict the
 * scanner lock exists to prevent.
 *
 * So recovery here is cleanup-only, never resume: this just remembers which
 * ids were open the last time this file was written, so that if the process
 * dies without cleanly closing them, the next startup can find and delete
 * their orphaned temp PNGs from /tmp instead of leaking them forever. The
 * id itself is never reinserted as an active session/job.
 *
 * @param {string} fileName - e.g. ".sessions-open.json"
 * @param {(id: string) => string} tempFilePrefix - prefix shared by every
 *   temp file this id ever creates, e.g. id => `eduscan_${id}_`
 */
function createOpenIndex(fileName, tempFilePrefix) {
  const indexFile = path.join(SCANS_DIR, fileName);

  function readIds() {
    try {
      if (!fs.existsSync(indexFile)) return [];
      return JSON.parse(fs.readFileSync(indexFile, "utf8"));
    } catch (err) {
      logger.warn(`${fileName}: read failed — ${err.message}`);
      return [];
    }
  }

  function writeIds(ids) {
    try {
      ensureScansDirectory();
      fs.writeFileSync(indexFile, JSON.stringify(ids));
    } catch (err) {
      logger.warn(`${fileName}: write failed — ${err.message}`);
    }
  }

  function markOpen(id) {
    const ids = readIds();
    if (!ids.includes(id)) writeIds([...ids, id]);
  }

  function markClosed(id) {
    const ids = readIds();
    const next = ids.filter((existing) => existing !== id);
    if (next.length !== ids.length) writeIds(next);
  }

  function cleanupOrphanedTempFiles(id) {
    const prefix = tempFilePrefix(id);
    const tempDir = getTempDir();
    let names;
    try {
      names = fs.readdirSync(tempDir);
    } catch (err) {
      logger.warn(`Could not scan ${tempDir} for orphaned files (${id}): ${err.message}`);
      return;
    }
    for (const name of names) {
      if (!name.startsWith(prefix)) continue;
      try {
        fs.unlinkSync(path.join(tempDir, name));
        logger.info(`Removed orphaned temp file from unclean shutdown (${id}): ${name}`);
      } catch (err) {
        logger.warn(`Failed to remove orphaned temp file ${name}: ${err.message}`);
      }
    }
  }

  /** Call once at module load. Cleans up temp files only — never resumes. */
  function recoverOrphaned() {
    const ids = readIds();
    if (ids.length === 0) return;
    logger.warn(
      `${fileName}: recovering from an unclean shutdown — ${ids.length} entr${ids.length === 1 ? "y" : "ies"} left open. Cleaning up temp files (not resuming).`
    );
    for (const id of ids) cleanupOrphanedTempFiles(id);
    writeIds([]);
  }

  return { markOpen, markClosed, recoverOrphaned };
}

module.exports = { createOpenIndex };
