# Plan B — Electron Tray App Implementation Plan

**Goal:** Wrap the existing Express service inside an Electron desktop app that:
- Shows a system tray icon on Windows, Linux, and macOS
- Starts the HTTP server automatically on launch
- Auto-starts on OS login
- Produces distributable installers: `.exe` (Windows), `.deb` / `.AppImage` (Linux), `.dmg` (macOS)
- Requires zero terminal knowledge from end users

**Claude Code instruction:** Read this file top to bottom. Implement every section in order. Do not skip steps. After each section, verify the app still runs with `npm run electron`.

---

## Current Structure (do not change these)

```
scaning-nodejs/
├── index.js              ← Express server entry — DO NOT modify
├── src/
│   ├── app.js
│   ├── routes/
│   ├── services/
│   └── utils/
├── .env
├── package.json
└── node_modules/
```

---

## Target Structure After Implementation

```
scaning-nodejs/
├── electron/
│   ├── main.js           ← Electron entry point (create this)
│   ├── preload.js        ← Preload script (create this)
│   └── icons/
│       ├── icon.png      ← 512×512 source icon (add this)
│       ├── icon.ico      ← Windows icon (generated)
│       ├── icon.icns     ← macOS icon (generated)
│       └── tray-icon.png ← 22×22 tray icon (add this)
├── src/                  ← unchanged
├── index.js              ← unchanged
├── electron-main.js      ← root-level alias (create this, 1 line)
├── package.json          ← update (add electron deps + build config)
└── .env                  ← unchanged
```

---

## Step 1 — Install Dependencies

Run these commands in the project root:

```bash
# Electron itself
npm install electron --save-dev

# Build tool — produces .exe, .deb, .AppImage, .dmg
npm install electron-builder --save-dev

# Auto-start on OS login
npm install electron-squirrel-startup --save

# Show native OS notifications (optional but nice)
# Already available in Electron — no extra package needed
```

After install, verify `package.json` now has these in devDependencies:
- `electron`
- `electron-builder`

And in dependencies:
- `electron-squirrel-startup`

---

## Step 2 — Create `electron/main.js`

This is the core Electron file. Create it exactly as shown.

```js
// electron/main.js
'use strict';

// Handle Squirrel install/uninstall events on Windows (required for NSIS installer)
if (require('electron-squirrel-startup')) process.exit(0);

const { app, Tray, Menu, shell, nativeImage, Notification, dialog } = require('electron');
const path = require('path');
const { fork } = require('child_process');
const fs = require('fs');

// ─── Config ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 4545;
const SERVICE_URL = `http://localhost:${PORT}`;
const DOCS_URL    = `${SERVICE_URL}/`;
const HEALTH_URL  = `${SERVICE_URL}/api/health`;

// ─── State ───────────────────────────────────────────────────────────────────
let tray        = null;
let serverProcess = null;
let serverReady = false;
let isQuitting  = false;

// ─── Paths ───────────────────────────────────────────────────────────────────
// Works both in dev (project root) and packaged (resources/app/)
const ROOT_DIR   = app.isPackaged
  ? path.join(process.resourcesPath, 'app')
  : path.join(__dirname, '..');

const SERVER_ENTRY = path.join(ROOT_DIR, 'index.js');
const ICON_PATH    = path.join(__dirname, 'icons', 'icon.png');
const TRAY_ICON_PATH = path.join(__dirname, 'icons', 'tray-icon.png');

// ─── Prevent second instance ─────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

// ─── Start the Express server in a child process ──────────────────────────────
function startServer() {
  if (serverProcess) return;

  // Load .env — dotenv reads it relative to cwd
  const dotenvPath = path.join(ROOT_DIR, '.env');
  if (fs.existsSync(dotenvPath)) {
    require('dotenv').config({ path: dotenvPath });
  }

  serverProcess = fork(SERVER_ENTRY, [], {
    cwd: ROOT_DIR,
    silent: false,  // inherit stdout/stderr so logs flow to console
    env: { ...process.env, PORT: String(PORT) },
  });

  serverProcess.on('error', (err) => {
    console.error('[electron] Server process error:', err.message);
    serverReady = false;
    updateTray();
    showNotification('Service Error', err.message);
  });

  serverProcess.on('exit', (code) => {
    serverReady = false;
    serverProcess = null;
    if (!isQuitting) {
      console.warn(`[electron] Server exited (code ${code}) — restarting in 3s`);
      updateTray();
      setTimeout(startServer, 3000);
    }
  });

  // Poll health endpoint until server is up
  waitForServer(10, 800);
}

function stopServer() {
  if (!serverProcess) return;
  serverProcess.kill('SIGTERM');
  serverProcess = null;
  serverReady = false;
}

// Poll /api/health until the server responds
function waitForServer(retriesLeft, delayMs) {
  const http = require('http');
  const req = http.get(HEALTH_URL, (res) => {
    if (res.statusCode === 200) {
      serverReady = true;
      updateTray();
      console.log('[electron] Server is ready at', SERVICE_URL);
    } else if (retriesLeft > 0) {
      setTimeout(() => waitForServer(retriesLeft - 1, delayMs), delayMs);
    }
  });
  req.on('error', () => {
    if (retriesLeft > 0) {
      setTimeout(() => waitForServer(retriesLeft - 1, delayMs), delayMs);
    }
  });
  req.setTimeout(1000, () => req.destroy());
}

// ─── Tray ─────────────────────────────────────────────────────────────────────
function createTray() {
  const iconFile = fs.existsSync(TRAY_ICON_PATH) ? TRAY_ICON_PATH : ICON_PATH;
  const icon = nativeImage.createFromPath(iconFile);

  // On macOS, mark as template image for dark-mode support
  if (process.platform === 'darwin') icon.setTemplateImage(true);

  tray = new Tray(icon.resize({ width: 22, height: 22 }));
  tray.setToolTip('Print & Scan Service');
  updateTray();

  // Left-click opens docs on macOS/Linux (Windows uses context menu only)
  tray.on('click', () => {
    if (serverReady) shell.openExternal(DOCS_URL);
  });
}

function updateTray() {
  if (!tray) return;

  const statusLabel  = serverReady ? '● Running on port ' + PORT : '○ Starting…';
  const statusColor  = serverReady ? 'ready' : 'loading';

  const contextMenu = Menu.buildFromTemplate([
    // Header — not clickable
    { label: 'Print & Scan Service', enabled: false },
    { label: statusLabel,            enabled: false },
    { type: 'separator' },

    // Actions
    {
      label: 'Open Docs / API Reference',
      enabled: serverReady,
      click: () => shell.openExternal(DOCS_URL),
    },
    {
      label: 'Open Scanner Test',
      enabled: serverReady,
      click: () => shell.openExternal(`${SERVICE_URL}/api/health`),
    },
    { type: 'separator' },

    // Service control
    {
      label: 'Restart Service',
      click: () => {
        serverReady = false;
        updateTray();
        stopServer();
        setTimeout(startServer, 500);
      },
    },
    { type: 'separator' },

    // Settings
    {
      label: 'Start at Login',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (menuItem) => {
        app.setLoginItemSettings({ openAtLogin: menuItem.checked });
      },
    },
    {
      label: 'View Logs',
      click: () => shell.openPath(app.getPath('logs')),
    },
    { type: 'separator' },

    // Quit
    {
      label: 'Quit Print & Scan Service',
      click: () => {
        isQuitting = true;
        stopServer();
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
}

// ─── Notifications ────────────────────────────────────────────────────────────
function showNotification(title, body) {
  if (!Notification.isSupported()) return;
  new Notification({ title, body, icon: ICON_PATH }).show();
}

// ─── App lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  // Hide from macOS Dock — this is a background service
  if (process.platform === 'darwin') app.dock.hide();

  // No main window — tray only
  createTray();
  startServer();

  // Show a startup notification
  setTimeout(() => {
    if (serverReady) {
      showNotification('Print & Scan Service', `Running on port ${PORT}`);
    }
  }, 3000);
});

// Keep alive even when all windows closed
app.on('window-all-closed', (e) => {
  if (!isQuitting) e.preventDefault();
});

// Handle second-instance (user double-clicked the app again)
app.on('second-instance', () => {
  if (serverReady) shell.openExternal(DOCS_URL);
});

app.on('before-quit', () => {
  isQuitting = true;
  stopServer();
});
```

---

## Step 3 — Create `electron/preload.js`

Simple preload — kept minimal since this app has no renderer window.

```js
// electron/preload.js
'use strict';
// Preload is required by electron-builder conventions.
// This app has no BrowserWindow so preload is a no-op.
window.__printScanVersion = process.env.npm_package_version;
```

---

## Step 4 — Create Root-Level `electron-main.js`

One-line alias so electron-builder's `main` field in package.json resolves correctly:

```js
// electron-main.js  (project root)
module.exports = require('./electron/main.js');
```

---

## Step 5 — Add Icons

You need two icon files in `electron/icons/`:

| File | Size | Used for |
|---|---|---|
| `icon.png` | 512×512 px | macOS .icns, Linux, notifications |
| `tray-icon.png` | 22×22 px | System tray (all platforms) |
| `icon.ico` | multi-size | Windows (auto-generated by electron-builder from icon.png) |
| `icon.icns` | multi-size | macOS (auto-generated by electron-builder from icon.png) |

**Quick way to generate a placeholder icon for development:**

```bash
# Install imagemagick if not already installed
# Ubuntu: sudo apt install imagemagick
# macOS:  brew install imagemagick

# Create a simple colored square as placeholder
convert -size 512x512 xc:#2E4057 \
  -fill white -font DejaVu-Sans-Bold -pointsize 120 \
  -gravity center -annotate 0 "P&S" \
  electron/icons/icon.png

convert -size 22x22 xc:#2E4057 electron/icons/tray-icon.png
```

**For production:** Replace these with your actual brand icons before building.

electron-builder will auto-convert `icon.png` → `icon.ico` and `icon.icns` during the build step. You do NOT need to create those manually.

---

## Step 6 — Update `package.json`

Add/update these fields in `package.json`. Merge carefully — do not remove existing keys.

```json
{
  "name": "print-scan-service",
  "version": "1.0.0",
  "description": "Silent print and scan local service",
  "main": "electron-main.js",
  "scripts": {
    "start":         "node index.js",
    "dev":           "nodemon index.js",
    "electron":      "electron .",
    "electron:dev":  "NODE_ENV=development electron .",
    "build:win":     "electron-builder --win",
    "build:linux":   "electron-builder --linux",
    "build:mac":     "electron-builder --mac",
    "build:all":     "electron-builder --win --linux --mac",
    "dist":          "npm run build:all"
  },
  "build": {
    "appId": "com.yourdomain.print-scan-service",
    "productName": "Print & Scan Service",
    "copyright": "Copyright © 2026",
    "asar": true,
    "asarUnpack": [
      "node_modules/puppeteer/**",
      "node_modules/pdf-to-printer/**"
    ],
    "files": [
      "electron/**",
      "electron-main.js",
      "index.js",
      "src/**",
      ".env",
      "node_modules/**",
      "!node_modules/.cache/**",
      "!**/*.map",
      "!**/test/**",
      "!**/tests/**",
      "!**/.git/**"
    ],
    "extraResources": [
      {
        "from": "scans",
        "to":   "app/scans",
        "filter": ["**/*"]
      }
    ],
    "icon": "electron/icons/icon",
    "win": {
      "target": [
        { "target": "nsis",    "arch": ["x64"] },
        { "target": "portable","arch": ["x64"] }
      ],
      "icon": "electron/icons/icon.ico"
    },
    "nsis": {
      "oneClick": false,
      "allowToChangeInstallationDirectory": true,
      "createDesktopShortcut": true,
      "createStartMenuShortcut": true,
      "shortcutName": "Print & Scan Service",
      "installerIcon": "electron/icons/icon.ico",
      "uninstallerIcon": "electron/icons/icon.ico",
      "runAfterFinish": true
    },
    "linux": {
      "target": [
        { "target": "AppImage", "arch": ["x64"] },
        { "target": "deb",      "arch": ["x64"] }
      ],
      "icon": "electron/icons/icon.png",
      "category": "Utility",
      "desktop": {
        "Name": "Print & Scan Service",
        "Comment": "Silent local print and scan API service",
        "StartupNotify": "false"
      }
    },
    "deb": {
      "depends": [
        "sane-utils",
        "imagemagick",
        "libnotify4"
      ],
      "afterInstall": "scripts/postinstall.sh",
      "afterRemove":  "scripts/postremove.sh"
    },
    "mac": {
      "target": [
        { "target": "dmg", "arch": ["x64", "arm64"] },
        { "target": "zip", "arch": ["x64", "arm64"] }
      ],
      "icon": "electron/icons/icon.icns",
      "category": "public.app-category.utilities",
      "hardenedRuntime": true,
      "gatekeeperAssess": false,
      "entitlements": "electron/entitlements.mac.plist",
      "entitlementsInherit": "electron/entitlements.mac.plist"
    },
    "dmg": {
      "title": "Print & Scan Service",
      "icon": "electron/icons/icon.icns",
      "contents": [
        { "x": 130, "y": 220 },
        { "x": 410, "y": 220, "type": "link", "path": "/Applications" }
      ]
    }
  }
}
```

---

## Step 7 — Create macOS Entitlements File

Required for macOS notarization and hardened runtime. Without this, the app will be blocked by Gatekeeper on modern macOS.

Create `electron/entitlements.mac.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key>
  <true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
  <true/>
  <key>com.apple.security.cs.disable-library-validation</key>
  <true/>
  <key>com.apple.security.automation.apple-events</key>
  <true/>
  <key>com.apple.security.network.client</key>
  <true/>
  <key>com.apple.security.network.server</key>
  <true/>
  <key>com.apple.security.files.user-selected.read-write</key>
  <true/>
</dict>
</plist>
```

---

## Step 8 — Create Linux Post-Install / Post-Remove Scripts

These run after `.deb` install/remove to set up system dependencies.

Create `scripts/postinstall.sh`:

```bash
#!/bin/bash
# Runs after .deb package install

# Enable the app to open scanners without root
if ! groups $USER | grep -q "scanner"; then
  usermod -aG scanner $USER 2>/dev/null || true
fi

# Check for required scanner tools
if ! command -v scanimage &>/dev/null; then
  echo "[Print & Scan Service] WARNING: scanimage not found."
  echo "  Install with: sudo apt install sane-utils"
fi

if ! command -v convert &>/dev/null && ! command -v magick &>/dev/null; then
  echo "[Print & Scan Service] WARNING: ImageMagick not found."
  echo "  Install with: sudo apt install imagemagick"
fi

echo "[Print & Scan Service] Installation complete."
echo "  Launch from your Applications menu or run: print-scan-service"
```

Create `scripts/postremove.sh`:

```bash
#!/bin/bash
echo "[Print & Scan Service] Uninstalled."
```

Make them executable:
```bash
chmod +x scripts/postinstall.sh scripts/postremove.sh
```

---

## Step 9 — Handle Puppeteer in Packaged App

Puppeteer bundles Chromium. electron-builder's `asar` packaging breaks Puppeteer's ability to find its bundled Chromium binary. We already added `asarUnpack` in Step 6, but also patch the launch call.

Update `src/services/printService.js` — modify the `getBrowser()` function (after implementing the singleton from the audit P-01 fix):

```js
// src/services/printService.js

function getPuppeteerExecutable() {
  // In packaged Electron app, Chromium is in asarUnpack directory
  if (process.versions.electron) {
    const { executablePath } = require('puppeteer');
    // asarUnpack puts it under resources/app.asar.unpacked/
    const unpacked = executablePath().replace('app.asar', 'app.asar.unpacked');
    const fs = require('fs');
    if (fs.existsSync(unpacked)) return unpacked;
  }
  return undefined; // let Puppeteer find it normally in dev
}

async function getBrowser() {
  if (_browser) {
    try { await _browser.version(); return _browser; } catch { _browser = null; }
  }
  const puppeteer = require('puppeteer');
  const executablePath = getPuppeteerExecutable();
  _browser = await puppeteer.launch({
    headless: true,
    executablePath,   // undefined in dev = use default; path in packaged = use unpacked
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
  });
  return _browser;
}

// Export close function for graceful shutdown
async function closeBrowser() {
  if (_browser) { await _browser.close(); _browser = null; }
}

module.exports = {
  printFromHtml,
  convertHtmlToPdf,
  printPdf,
  cleanupTempPdf,
  closeBrowser,  // ← new export
};
```

---

## Step 10 — Update `index.js` for Electron Context

The existing `index.js` calls `app.listen()` and logs to console. This is fine — `electron/main.js` forks it as a child process. No changes needed to `index.js`.

However, add this safety check at the top of `index.js` so it doesn't crash when imported in an unexpected context:

```js
// index.js — add at the very top, before require("dotenv").config()
if (process.versions.electron && !process.env.ELECTRON_FORKED) {
  // If somehow loaded directly inside Electron (not via fork), skip server start
  console.warn('[index.js] Running inside Electron main process — use fork() to start the server');
  process.exit(0);
}
```

And in `electron/main.js` `startServer()`, add the env flag to the fork:

```js
serverProcess = fork(SERVER_ENTRY, [], {
  cwd: ROOT_DIR,
  silent: false,
  env: {
    ...process.env,
    PORT: String(PORT),
    ELECTRON_FORKED: '1',   // ← add this
  },
});
```

---

## Step 11 — Add `.env` Default Generator

When a user installs the app for the first time, `.env` may not exist. Add a fallback in `electron/main.js` inside `startServer()`, before `require('dotenv').config()`:

```js
// electron/main.js — add inside startServer(), before dotenv.config()
const dotenvPath = path.join(ROOT_DIR, '.env');
if (!fs.existsSync(dotenvPath)) {
  const examplePath = path.join(ROOT_DIR, '.env.example');
  if (fs.existsSync(examplePath)) {
    fs.copyFileSync(examplePath, dotenvPath);
    console.log('[electron] Created .env from .env.example');
  }
}
```

This means you must commit `.env.example` with safe defaults (already in the audit recommendations).

---

## Step 12 — Test in Development

```bash
# Run the Electron app (server starts inside Electron):
npm run electron

# You should see:
#  - A tray icon appear in your taskbar/menu bar
#  - Right-click it → context menu with "Running on port 4545"
#  - Click "Open Docs" → browser opens http://localhost:4545
```

**Checklist before building:**
- [ ] Tray icon appears
- [ ] Context menu shows "● Running on port 4545"
- [ ] "Open Docs" opens the browser
- [ ] "Restart Service" restarts and updates tray status
- [ ] "Start at Login" checkbox toggles correctly
- [ ] "Quit" exits the app and kills the server

---

## Step 13 — Build Distributables

### Build for current platform (recommended to start):

```bash
# On Windows — produces dist/Print & Scan Service Setup 1.0.0.exe
npm run build:win

# On Linux — produces dist/Print & Scan Service-1.0.0.AppImage + .deb
npm run build:linux

# On macOS — produces dist/Print & Scan Service-1.0.0.dmg
npm run build:mac
```

### Build for all platforms (needs Docker or a CI pipeline for cross-build):

```bash
npm run build:all
```

Output goes to `dist/` folder in the project root.

---

## Step 14 — Platform-Specific Notes

### Windows
- The NSIS installer will: create Start Menu shortcut, optionally create Desktop shortcut, run the app after install
- The app shows in the system tray (bottom-right of taskbar)
- Windows Defender SmartScreen may warn on first run because the binary is unsigned. To remove the warning: buy a code signing certificate (~$70/year) and add to electron-builder config
- NAPS2 must still be installed separately for scanning. Add a check in `electron/main.js` on Windows:

```js
// electron/main.js — add to app.whenReady():
if (process.platform === 'win32') {
  const NAPS2 = process.env.NAPS2_PATH || 'C:\\Program Files\\NAPS2\\naps2.console.exe';
  if (!fs.existsSync(NAPS2)) {
    dialog.showMessageBox(null, {
      type: 'warning',
      title: 'NAPS2 Not Found',
      message: 'NAPS2 is required for scanning on Windows.',
      detail: 'Download and install NAPS2 from https://www.naps2.com\nThen restart Print & Scan Service.',
      buttons: ['Download NAPS2', 'Skip'],
    }).then(({ response }) => {
      if (response === 0) shell.openExternal('https://www.naps2.com');
    });
  }
}
```

### Linux / Ubuntu
- `.deb` installs to `/opt/Print & Scan Service/`
- The `postinstall.sh` checks for `sane-utils` and `imagemagick`
- AppImage is portable (no install needed) — good for quick testing
- The tray icon may not appear on some GNOME versions without the `gnome-shell-extension-appindicator` extension. Add this to your README

### macOS
- App lives in `/Applications/Print & Scan Service.app`
- Dock icon is hidden at launch (background service)
- Menu bar icon appears at top right
- First launch: macOS will ask for permission to control the computer for printing — click Allow
- SANE requires `brew install sane-backends` — add a check similar to the Windows NAPS2 check

---

## Step 15 — Auto-Update (Optional but Recommended)

Add auto-update so users get new versions automatically:

```bash
npm install electron-updater --save
```

Add to `electron/main.js`:

```js
const { autoUpdater } = require('electron-updater');

// In app.whenReady():
// Check for updates 5 seconds after startup (non-blocking)
setTimeout(() => {
  autoUpdater.checkForUpdatesAndNotify().catch(() => {
    // Silently fail if no update server configured
  });
}, 5000);

autoUpdater.on('update-downloaded', () => {
  tray.setToolTip('Print & Scan Service — Update ready!');
  updateTray(); // will add "Install Update" item
});
```

Add to `package.json` `build` section:

```json
"publish": {
  "provider": "github",
  "owner":    "your-github-username",
  "repo":     "print-scan-service"
}
```

Then push releases to GitHub and electron-updater handles the rest.

---

## File Creation Checklist

Claude Code — create all of these files:

- [ ] `electron/main.js` — full content from Step 2
- [ ] `electron/preload.js` — content from Step 3
- [ ] `electron-main.js` (root) — content from Step 4
- [ ] `electron/icons/` — directory (icons added manually by developer)
- [ ] `electron/entitlements.mac.plist` — content from Step 7
- [ ] `scripts/postinstall.sh` — content from Step 8
- [ ] `scripts/postremove.sh` — content from Step 8
- [ ] Update `package.json` — merge changes from Step 6
- [ ] Update `src/services/printService.js` — apply P-01 singleton + Puppeteer path fix from Step 9
- [ ] Update `index.js` — add Electron safety check from Step 10

---

## npm Scripts Reference

| Command | What it does |
|---|---|
| `npm run electron` | Run app in dev mode (no build) |
| `npm run electron:dev` | Same but sets NODE_ENV=development |
| `npm run build:win` | Build Windows installer (.exe + portable) |
| `npm run build:linux` | Build Linux packages (.AppImage + .deb) |
| `npm run build:mac` | Build macOS disk image (.dmg) |
| `npm run build:all` | Build all platforms |

---

## Key Design Decisions

| Decision | Reason |
|---|---|
| Fork server as child process (not inline) | Server crash doesn't kill Electron; easy restart |
| `app.dock.hide()` on macOS | Background service — no Dock icon clutter |
| `app.requestSingleInstanceLock()` | Prevents two instances opening two servers on same port |
| `asarUnpack` for Puppeteer | Chromium binary can't run from inside .asar archive |
| Health poll instead of IPC | Simpler; works even if server crashes and restarts |
| `.env.example` → `.env` copy | First-run experience works without manual .env setup |

---

## Known Limitations

- Cross-platform builds (e.g. building `.exe` on macOS) requires Docker or a CI service like GitHub Actions. Build each platform on its own OS for simplest setup.
- Puppeteer bundles ~170MB of Chromium — your installer will be large (~250MB). This is expected.
- On Linux, GNOME users may need `gnome-shell-extension-appindicator` for the tray icon to appear.
- Code signing is not included in this plan. Without it, Windows SmartScreen and macOS Gatekeeper will warn on first run. Add signing when ready for public distribution.

---

*End of Plan B Implementation Guide*
