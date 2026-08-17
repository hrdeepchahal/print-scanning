"use strict";

const { app } = require("electron");
const path = require("path");
const log = require("electron-log");
const Store = require("electron-store");
const ServerManager = require("./modules/ServerManager");
const TrayManager = require("./modules/TrayManager");
const DependencyManager = require("./modules/DependencyManager");
const { getScansDir } = require("../shared/platform");

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

log.transports.file.level = "info";
log.info(`App starting — v${app.getVersion()}`);

const store = new Store();

const serverEntry = app.isPackaged
  ? path.join(process.resourcesPath, "app", "index.js")
  : path.join(__dirname, "..", "index.js");

const server = new ServerManager({
  serverEntry,
  env: { PORT: process.env.PORT || "4545", SCANS_DIR: getScansDir() },
});

const tray = new TrayManager();

server.on("log", (line, level = "info") => log[level] ? log[level](`[server] ${line}`) : log.info(`[server] ${line}`));

app.whenReady().then(async () => {
  if (process.platform === "darwin") app.dock.hide();

  tray.create(server);

  // Must resolve before server.start(): ensureAll() sets process.env.NAPS2_PATH
  // (and similar), and ServerManager only copies process.env into the child's
  // env at the moment it forks — starting the server first would fork before
  // that env var exists.
  try {
    await DependencyManager.ensureAll(store, log);
  } catch (err) {
    log.error(err);
  }

  server.start();
});

app.on("window-all-closed", (e) => e.preventDefault()); // tray app — no windows to close
app.on("before-quit", () => server.quit());
