const os = require("os");
const util = require("util");
const exec = util.promisify(require("child_process").exec);
const logger = require("../utils/logger");

const CAPABILITY_CACHE_MS = parseInt(process.env.CAPABILITY_CACHE_MS) || 300000;

let _printerCache = { key: null, value: null, expiresAt: 0 };
let _scannerCache = { key: null, value: null, expiresAt: 0 };

/**
 * Parse a `lpoptions -p <printer> -l` line like:
 *   sides/2-Sided Printing: *one-sided two-sided-long-edge two-sided-short-edge
 * into the list of supported values (order preserved, `*` marker stripped).
 */
function parseLpoptionsValues(stdout, optionName) {
  const line = stdout.split("\n").find((l) => l.startsWith(`${optionName}/`) || l.startsWith(`${optionName}:`));
  if (!line) return [];
  const afterColon = line.slice(line.indexOf(":") + 1).trim();
  if (!afterColon) return [];
  return afterColon.split(/\s+/).map((v) => v.replace(/^\*/, ""));
}

/**
 * Parse a `scanimage --help -d <device>` line like:
 *   --source Flatbed|ADF [Flatbed]
 * into the list of supported source names.
 */
function parseScanimageSources(stdout) {
  const line = stdout.split("\n").find((l) => l.trim().startsWith("--source"));
  if (!line) return [];
  const match = line.match(/--source\s+([^\s[]+)/);
  if (!match) return [];
  return match[1].split("|").map((s) => s.trim()).filter(Boolean);
}

/**
 * Whether the given printer's CUPS driver exposes a duplex ("sides") option.
 * Linux/macOS only — Windows has no equivalent driver-introspection via
 * pdf-to-printer, so it returns `duplexSupported: null` (unknown, not false)
 * so callers can tell "not supported" apart from "couldn't check".
 */
async function getPrinterCapabilities(printerName) {
  if (os.platform() === "win32") {
    return { duplexSupported: null, sidesOptions: [] };
  }

  const cacheKey = printerName || "(default)";
  if (_printerCache.key === cacheKey && Date.now() < _printerCache.expiresAt) {
    return _printerCache.value;
  }

  let sidesOptions = [];
  try {
    const args = printerName ? `-p "${printerName}"` : "-d";
    const { stdout } = await exec(`lpoptions ${args} -l 2>/dev/null`);
    sidesOptions = parseLpoptionsValues(stdout, "sides");
  } catch (err) {
    logger.warn(`lpoptions capability check failed for "${cacheKey}": ${err.message}`);
  }

  const value = { duplexSupported: sidesOptions.some((o) => o.startsWith("two-sided")), sidesOptions };
  _printerCache = { key: cacheKey, value, expiresAt: Date.now() + CAPABILITY_CACHE_MS };
  return value;
}

/**
 * Whether the given SANE device has an ADF (feeder) source, not just Flatbed.
 * Linux/macOS only — Windows (NAPS2 CLI) has no equivalent check here yet,
 * so it returns `adfSupported: null` (unknown), same convention as above.
 *
 * Unlike getPrinterCapabilities, a failed *command* here also reports `null`
 * rather than `false`. This scanner is known to briefly refuse to reopen its
 * eSCL session right after a previous scan (see AIRSCAN_RETRY_DELAY_MS) —
 * `scanimage --help -d <device>` can hit that same transient failure. Callers
 * gate on `adfSupported === false` specifically so a flaky check never blocks
 * a scan that would otherwise have worked; only a check that actually
 * completed and found no ADF source blocks it.
 */
async function getScannerCapabilities(device) {
  if (os.platform() === "win32") {
    return { adfSupported: null, sources: [] };
  }

  const cacheKey = device || "(default)";
  if (_scannerCache.key === cacheKey && Date.now() < _scannerCache.expiresAt) {
    return _scannerCache.value;
  }

  let sources = null;
  try {
    const deviceArg = device ? `-d "${device}"` : "";
    const { stdout } = await exec(`scanimage --help ${deviceArg} 2>/dev/null`);
    sources = parseScanimageSources(stdout);
  } catch (err) {
    logger.warn(`scanimage capability check failed for "${cacheKey}": ${err.message}`);
  }

  const value = {
    adfSupported: sources === null ? null : sources.some((s) => s.toLowerCase() === "adf"),
    sources: sources || [],
  };
  _scannerCache = { key: cacheKey, value, expiresAt: Date.now() + CAPABILITY_CACHE_MS };
  return value;
}

/**
 * Combined snapshot for the startup log and GET /api/capabilities.
 * The scanner device is resolved via detectLinuxDeviceForced() rather than
 * read raw from SANE_DEVICE — the pinned env value's `airscan:eN:` index can
 * drift after the scanner re-advertises (see matchPinnedDevice in
 * scanService.js), so checking the raw env string could silently check a
 * stale/wrong device name.
 */
async function getAllCapabilities(printerName = process.env.PRINTER_NAME) {
  let device = process.env.SANE_DEVICE || "";
  if (os.platform() !== "win32") {
    try {
      device = await require("./scanService").detectLinuxDeviceForced();
    } catch (err) {
      logger.warn(`Device detection failed during capability check: ${err.message}`);
    }
  }

  const [printer, scanner] = await Promise.all([
    getPrinterCapabilities(printerName),
    getScannerCapabilities(device),
  ]);
  return {
    printer: { name: printerName || null, ...printer },
    scanner: { device: device || null, ...scanner },
  };
}

module.exports = {
  getPrinterCapabilities,
  getScannerCapabilities,
  getAllCapabilities,
};
