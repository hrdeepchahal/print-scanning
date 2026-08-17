"use strict";

const crypto = require("crypto");
const fs = require("fs");

/** Single source for session/job IDs — pass bytes to match a caller's previous length. */
function generateId(bytes = 12) {
  return crypto.randomBytes(bytes).toString("hex");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Best-effort unlink of every path; missing/already-removed files are not an error. */
function cleanupFiles(paths = []) {
  for (const p of paths) {
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch (_) {}
  }
}

module.exports = { generateId, sleep, cleanupFiles };
