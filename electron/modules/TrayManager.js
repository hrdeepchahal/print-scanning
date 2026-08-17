"use strict";

const { Tray, Menu, nativeImage, shell } = require("electron");
const path = require("path");

const ICON_PATH = path.join(__dirname, "..", "..", "build", "icon.png");

/**
 * System tray icon + menu. Listens to a ServerManager's 'online'/'offline'
 * events to update its status line — knows nothing about how the server
 * itself works.
 */
class TrayManager {
  constructor() {
    this.tray = null;
    this.port = null;
    this.state = { online: false };
  }

  create(serverManager) {
    const icon = nativeImage.createFromPath(ICON_PATH).resize({ width: 16, height: 16 });
    if (process.platform === "darwin") icon.setTemplateImage(true);

    this.tray = new Tray(icon);
    this.tray.setToolTip("Print & Scan Service");

    serverManager.on("online", (payload) => {
      this.port = payload && payload.port;
      this.updateStatus("online");
    });
    serverManager.on("offline", () => this.updateStatus("offline"));

    this.updateStatus("starting");
    return this.tray;
  }

  updateStatus(status) {
    this.state = { ...this.state, status };
    this._render();
  }

  _render() {
    if (!this.tray) return;
    const isOnline = this.state.status === "online";
    const statusLine = isOnline
      ? `● Running on :${this.port}`
      : this.state.status === "offline"
        ? "○ Restarting…"
        : "○ Starting…";

    const template = [
      { label: "Print & Scan Service", enabled: false },
      { label: statusLine, enabled: false },
      { type: "separator" },
      {
        label: "Open Dashboard",
        enabled: isOnline,
        click: () => shell.openExternal(`http://localhost:${this.port}`),
      },
      { type: "separator" },
      { label: "Quit", click: () => require("electron").app.quit() },
    ];

    this.tray.setContextMenu(Menu.buildFromTemplate(template));
  }
}

module.exports = TrayManager;
