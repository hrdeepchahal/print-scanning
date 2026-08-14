const logger = require("../utils/logger");

/*
 * Physical scanner devices can only be opened by one process at a time — two
 * concurrent scanimage processes against the same hardware either both fail
 * to open the device or corrupt each other's in-flight scan.
 *
 * Session and auto-scan jobs hold the device open across many separate HTTP
 * requests (minutes at a time — see scanSession.routes.js / autoScanJobManager.js),
 * so this is a single held/released busy flag scoped to the actual device
 * open/close window, not a per-request promise queue. Callers acquire with a
 * label identifying the session/job/request that owns the device, and must
 * release with that same label once the device is actually closed.
 */
let _holder = null; // { label, since } | null

function acquireScannerLock(label) {
  if (_holder) {
    logger.warn(
      `Scanner busy — "${label}" rejected, held by "${_holder.label}" since ${new Date(_holder.since).toISOString()}`
    );
    return false;
  }
  _holder = { label, since: Date.now() };
  logger.info(`Scanner lock acquired by "${label}"`);
  return true;
}

/** No-op if `label` isn't the current holder — safe to call from cleanup paths that may race. */
function releaseScannerLock(label) {
  if (_holder && _holder.label === label) {
    logger.info(`Scanner lock released by "${label}"`);
    _holder = null;
  }
}

module.exports = { acquireScannerLock, releaseScannerLock };
