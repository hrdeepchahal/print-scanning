"use strict";

/** Mirrors the previous per-route parsing: parseInt(value) || default. */
function parseDpi(value, defaultDpi = 300) {
  return parseInt(value) || defaultDpi;
}

/** Scanner-supported DPI range (matches the checks previously duplicated per-route: 72–1200). */
function validateDpi(dpi) {
  return typeof dpi === "number" && !isNaN(dpi) && dpi >= 72 && dpi <= 1200;
}

/** parseInt with a min/max range; returns null when missing or out of range. */
function parsePageCount(value, { min = 1, max = 100 } = {}) {
  const parsed = parseInt(value);
  if (!parsed || parsed < min || parsed > max) return null;
  return parsed;
}

/** True when an error message indicates a client-fixable condition rather than a server/hardware fault. */
function isClientError(err) {
  const msg = (err && err.message) || "";
  return (
    msg.includes("not found") ||
    msg.includes("not installed") ||
    msg.includes("not connected") ||
    msg.includes("Unsupported platform") ||
    msg.includes("face-down")
  );
}

module.exports = { parseDpi, validateDpi, parsePageCount, isClientError };
