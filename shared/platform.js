"use strict";

const os = require("os");
const path = require("path");
const fs = require("fs");

const IS_WIN = process.platform === "win32";
const IS_LINUX = process.platform === "linux";
const IS_MAC = process.platform === "darwin";

/**
 * Shared scratch directory for temp scan PNGs and print PDFs. Absolute and
 * writable on every platform (unlike a hardcoded "/tmp", which doesn't exist
 * on Windows) and stable across restarts so orphan cleanup (crashRecovery.js)
 * can find files left behind by a previous run.
 */
function getTempDir() {
  const dir = path.join(os.tmpdir(), "print-scanning");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Root directory for saved scan PDFs. Inside a packaged Electron app this
 * must be the OS-designated user data directory — the install directory is
 * read-only on Windows/macOS. Outside Electron (plain `node index.js`), the
 * project-relative "./scans" behavior is unchanged.
 *
 * The server itself runs as a `child_process.fork()`ed child of the Electron
 * main process, and Electron forces ELECTRON_RUN_AS_NODE for forked
 * children — in that context `require("electron")` returns a plain path
 * string, not the real API, so `.app` doesn't exist. Guard for that instead
 * of throwing; electron/main.js (the real Electron main context) is what
 * actually resolves this and passes it to the child via SCANS_DIR env.
 */
function getScansDir() {
  try {
    if (process.versions.electron) {
      const electron = require("electron");
      if (electron && electron.app && typeof electron.app.getPath === "function") {
        return path.join(electron.app.getPath("userData"), "scans");
      }
    }
  } catch (_) {}
  return path.join(process.cwd(), "scans");
}

/** Windows NAPS2 CLI path — DependencyManager sets NAPS2_PATH before forking the server. */
function getNaps2Path() {
  return process.env.NAPS2_PATH || "C:\\Program Files\\NAPS2\\naps2.console.exe";
}

module.exports = { IS_WIN, IS_LINUX, IS_MAC, getTempDir, getScansDir, getNaps2Path };
