"use strict";
/**
 * Copies this machine's locally-installed Puppeteer Chromium into
 * resources/chromium/<platform>/ so electron-builder can bundle it via
 * extraResources (see electron-builder.yml).
 *
 * Why this exists: Puppeteer 20+ downloads Chromium to the OS user cache
 * (~/.cache/puppeteer on Linux/macOS, %LOCALAPPDATA%\puppeteer on Windows) —
 * a path that only exists on the machine that ran `npm install`, not inside
 * the project tree electron-builder packages. Without this, the packaged app
 * has no Chromium to launch on an end-user's machine and every print request
 * fails (see printService.js's getBundledChromiumPath()).
 *
 * Must be run on each target OS before building for that OS — same
 * constraint as building native modules (sharp) cross-platform: build
 * Windows on Windows, macOS on macOS, Linux on Linux.
 */
const fs = require("fs");
const path = require("path");

function copyRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyRecursive(s, d);
    else fs.copyFileSync(s, d);
  }
}

function platformDirName() {
  if (process.platform === "win32") return "win32";
  if (process.platform === "darwin") return "darwin";
  return "linux";
}

const puppeteer = require("puppeteer");
const execPath = puppeteer.executablePath();

if (!fs.existsSync(execPath)) {
  console.error(`Puppeteer Chromium not found at ${execPath}. Run "npm install" first.`);
  process.exit(1);
}

const sourceDir = path.dirname(execPath); // self-contained Chromium directory
const target = path.join(__dirname, "..", "resources", "chromium", platformDirName());

if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
copyRecursive(sourceDir, target);

console.log(`Staged Chromium: ${sourceDir} -> ${target}`);
console.log(`(${path.basename(execPath)} — printService.js's getBundledChromiumPath() expects this exact filename)`);
