# Architecture Review — Production-Grade Analysis

**Scope:** Existing Express service (`src/`) + `ELECTRON_PLAN.md`  
**Standard:** Senior engineering review — production, scalable, maintainable  
**Rule:** No functionality changes. Upgrade quality, scalability, and maintainability only.

---

## Table of Contents

1. [Bad Architecture Decisions](#1-bad-architecture-decisions)
2. [Performance Bottlenecks](#2-performance-bottlenecks)
3. [Maintainability Issues](#3-maintainability-issues)
4. [Duplicate Logic — Full Inventory](#4-duplicate-logic--full-inventory)
5. [Clean Architecture Breakdown](#5-clean-architecture-breakdown)
6. [Critical Problems & Solutions](#6-critical-problems--solutions)
7. [Production-Grade Implementation Plan](#7-production-grade-implementation-plan)

---

## 1. Bad Architecture Decisions

### 1.1 — Electron Layer (ELECTRON_PLAN.md)

---

#### ❌ BAD-01: Monolithic `electron/main.js` — 6 Responsibilities in One File

**What the plan proposes:**
```
electron/main.js  ← tray management + server lifecycle +
                     health polling + notifications +
                     auto-update + settings + NAPS2 check
```

**Why it's wrong:**  
Single Responsibility Principle (SRP) broken across every dimension.
When the tray needs changing, you're editing the same file as the crash-restart logic.
When auto-update breaks, you're debugging next to the icon resize code.
This file will hit 400+ lines within the first week of real development.

**Fix:** Module-per-concern. See Section 5.

---

#### ❌ BAD-02: HTTP Health Polling to Detect Server Readiness

**What the plan proposes:**
```js
// poll http://localhost:4545/api/health every 800ms
function waitForServer(retriesLeft, delayMs) {
  const req = http.get(HEALTH_URL, ...);
  // 10 retries × 800ms = max 8 seconds to detect ready
}
```

**Why it's wrong:**  
You already have a direct communication channel: `child_process.fork()` gives you
a bidirectional IPC channel for free. You're ignoring it and making an HTTP network
roundtrip to talk to a process you spawned yourself.

The server is on the same machine. IPC is microseconds. HTTP polling is 800ms + per attempt.
If the server starts in 400ms, you wait 800ms to find out. If it starts in 810ms, you wait 1600ms.

**Fix:**
```js
// server/index.js — signal ready via IPC:
app.listen(PORT, () => {
  if (process.send) process.send({ type: 'ready', port: PORT });
});

// electron/modules/ServerManager.js — listen for IPC:
serverProcess.on('message', (msg) => {
  if (msg.type === 'ready') this.emit('ready', msg.port);
});
```
Zero polling. Instant detection. Works regardless of port or startup time.

---

#### ❌ BAD-03: `fork()` with `silent: false` — Server Logs Lost in Production

**What the plan proposes:**
```js
serverProcess = fork(SERVER_ENTRY, [], {
  silent: false,  // inherit stdout/stderr
  ...
});
```

**Why it's wrong:**  
`silent: false` means "use parent's stdout/stderr." In a packaged Electron app,
there IS no terminal. No console. The parent process IS the Electron binary.
Every `console.log`, every Winston log written to stdout: **silently discarded**.
Your operators will have zero visibility into what the server is doing.

**Fix:**
```js
// Use silent: true, then pipe to electron-log:
serverProcess = fork(SERVER_ENTRY, [], { silent: true });

serverProcess.stdout.on('data', (data) =>
  data.toString().split('\n').filter(Boolean).forEach(line =>
    log.info(`[server] ${line}`)
  )
);
serverProcess.stderr.on('data', (data) =>
  data.toString().split('\n').filter(Boolean).forEach(line =>
    log.error(`[server] ${line}`)
  )
);
```
Now every server log flows into `electron-log`'s rotating file at `app.getPath('logs')`.

---

#### ❌ BAD-04: `electron-squirrel-startup` + NSIS — Incompatible Installers Together

**What the plan proposes:**
```js
// At the top of main.js:
if (require('electron-squirrel-startup')) process.exit(0);
// AND in package.json:
"win": { "target": [{ "target": "nsis" }] }
```

**Why it's wrong:**  
`electron-squirrel-startup` handles install/uninstall lifecycle events
for the **Squirrel** installer (used by GitHub Releases auto-updater).
The plan uses **NSIS** as the Windows installer target — these are two completely
different installer systems. NSIS does not emit Squirrel lifecycle events.
The `electron-squirrel-startup` import is dead code at best, a confusing trap at worst.

**Fix:** Remove `electron-squirrel-startup` entirely. If you want Windows auto-update
later, use `electron-updater` with NSIS (it handles its own lifecycle).

---

#### ❌ BAD-05: `scans/` Folder in `extraResources` — Writes to Read-Only App Bundle

**What the plan proposes:**
```json
"extraResources": [
  { "from": "scans", "to": "app/scans" }
]
```

**Why it's wrong:**  
On macOS, apps in `/Applications` are typically owned by root. Writing to
`/Applications/PrintScanService.app/Contents/Resources/app/scans/` will fail
with `EACCES` (permission denied) the moment a user without admin rights tries to scan.
On Windows, `C:\Program Files\` is also protected. You are trying to write user data
into the application installation directory — a fundamental violation of OS conventions.

**Fix:**
```js
// Use the OS-designated user data directory:
const SCANS_DIR = path.join(app.getPath('userData'), 'scans');
// Windows: C:\Users\<user>\AppData\Roaming\PrintScanService\scans
// macOS:   ~/Library/Application Support/PrintScanService/scans
// Linux:   ~/.config/PrintScanService/scans

// Pass it to the server process via env:
serverProcess = fork(SERVER_ENTRY, [], {
  env: { ...process.env, SCANS_DIR }
});
```

---

#### ❌ BAD-06: `.env` Copy Logic Inside `startServer()` — Runs on Every Crash Restart

**What the plan proposes:**
```js
function startServer() {
  // .env copy logic here
  const dotenvPath = path.join(ROOT_DIR, '.env');
  if (!fs.existsSync(dotenvPath)) {
    fs.copyFileSync(examplePath, dotenvPath);
  }
  // then fork...
}
// startServer() is called again on every crash (setTimeout(startServer, 3000))
```

**Why it's wrong:**  
`startServer()` is designed to be called repeatedly (crash → restart → crash → restart).
Any initialization logic that should run **once** must not live inside a function that
runs many times. This specific case has a guard (`if (!existsSync)`), so it won't
double-copy, but the architectural pattern is wrong — it will bite you when you add
other one-time setup code here.

**Fix:** Run all one-time initialization in `app.whenReady()` before calling `startServer()`.
`startServer()` does exactly one thing: spawn the process.

---

#### ❌ BAD-07: NAPS2 Warning Dialog on Every Startup — No Persistence

**What the plan proposes:**
```js
// In app.whenReady():
if (!fs.existsSync(NAPS2)) {
  dialog.showMessageBox(null, { ... }); // fires every single startup
}
```

**Why it's wrong:**  
If NAPS2 is not installed, the user sees this dialog every time they start the app —
even if they already clicked "I'll do it later." This is the kind of thing that makes
users uninstall software.

**Fix:**
```js
// Use electron-store to remember:
const store = new Store();
if (!fs.existsSync(NAPS2) && !store.get('naps2WarningShown')) {
  store.set('naps2WarningShown', true);
  dialog.showMessageBox(...);
}
```

---

#### ❌ BAD-08: No Crash Backoff — Infinite Fast Restart Loop

**What the plan proposes:**
```js
serverProcess.on('exit', (code) => {
  if (!isQuitting) {
    setTimeout(startServer, 3000); // always 3 seconds, always restarts
  }
});
```

**Why it's wrong:**  
If the server has a startup error (port already bound, missing module, syntax error),
it exits immediately. Electron restarts it in 3 seconds. It exits immediately again.
This loops forever at 3-second intervals — burning CPU, filling logs, and making the
tray icon cycle between "Starting" and "Starting" with no explanation to the user.

**Fix — Exponential backoff with max attempts:**
```js
class ServerManager extends EventEmitter {
  #restartCount = 0;
  #maxRestarts = 5;
  #baseDelay = 2000;

  #scheduleRestart() {
    if (this.#restartCount >= this.#maxRestarts) {
      this.emit('fatal', 'Server failed to start after 5 attempts. Check logs.');
      return;
    }
    const delay = this.#baseDelay * Math.pow(2, this.#restartCount); // 2s, 4s, 8s, 16s, 32s
    this.#restartCount++;
    logger.warn(`Restarting server in ${delay}ms (attempt ${this.#restartCount})`);
    setTimeout(() => this.start(), delay);
  }

  // Reset counter on successful ready:
  #onReady() {
    this.#restartCount = 0;
    this.emit('ready');
  }
}
```

---

#### ❌ BAD-09: No IPC Protocol — Tray Is Completely Blind to Server State

**What the plan proposes:**
The tray shows "Running" or "Starting". That's it. There is no mechanism for
the server to tell Electron anything — not scan progress, not print completion,
not errors, not active session count. The tray is a dead indicator.

**Why it matters for production:**  
Operators need to see: is there an active scan? Did the last print job succeed?
How many sessions are open? Is the scanner connected? None of this is possible
without IPC.

**Fix — Define a typed IPC protocol:**
```js
// shared/ipc-events.js
const IPC = {
  // Server → Electron
  SERVER_READY:      'server:ready',
  SERVER_ERROR:      'server:error',
  SCAN_STARTED:      'scan:started',
  SCAN_PAGE_DONE:    'scan:page_done',
  SCAN_COMPLETE:     'scan:complete',
  PRINT_COMPLETE:    'print:complete',
  PRINT_FAILED:      'print:failed',
  SCANNER_STATUS:    'scanner:status',

  // Electron → Server
  SHUTDOWN:          'shutdown',
  RELOAD_CONFIG:     'reload:config',
  GET_STATUS:        'get:status',
};
module.exports = IPC;
```

---

#### ❌ BAD-10: Root-Level `electron-main.js` Is a One-Line Alias — Pointless Indirection

**What the plan proposes:**
```js
// electron-main.js (root)
module.exports = require('./electron/main.js');
```

**Why it's wrong:**  
This adds a file that does nothing except alias another file. In `package.json`,
just set `"main": "electron/main.js"` directly. Every developer who opens the repo
will look at `electron-main.js`, read one line, and ask "why does this exist?"

**Fix:** Delete `electron-main.js`. Set `"main": "electron/main.js"` in `package.json`.

---

#### ❌ BAD-11: `electron-builder` Config Bloating `package.json`

**What the plan proposes:**
80+ lines of `"build": { ... }` inline in `package.json`.

**Why it's wrong:**  
`package.json` is for npm metadata. Build tool configuration belongs in its own file.
80 lines of JSON in `package.json` makes it unreadable and untestable.

**Fix:** Extract to `electron-builder.yml`. electron-builder reads it automatically:
```yaml
# electron-builder.yml
appId: com.yourdomain.print-scan-service
productName: Print & Scan Service
asar: true
asarUnpack:
  - node_modules/puppeteer/**
  - node_modules/pdf-to-printer/**
```

---

#### ❌ BAD-12: No `electron-log` — All Electron-Layer Logs Disappear in Production

**What the plan proposes:**  
`console.log()` throughout `electron/main.js`.

**Why it's wrong:**  
In a packaged Electron app, `console.log` writes to nowhere. It is invisible.
If the tray crashes or the server manager misbehaves, you have zero diagnostic data.

**Fix:**
```bash
npm install electron-log
```
```js
const log = require('electron-log');
log.transports.file.level = 'info';
// Automatically writes to:
// Windows: %USERPROFILE%\AppData\Roaming\PrintScanService\logs\main.log
// macOS:   ~/Library/Logs/PrintScanService/main.log
// Linux:   ~/.config/PrintScanService/logs/main.log
```

---

#### ❌ BAD-13: No `electron-store` — Zero Settings Persistence

**What the plan proposes:**  
The tray checkbox for "Start at Login" uses `app.setLoginItemSettings()` (correct),
but there is no mechanism to persist any other setting:
- Default printer selected in tray
- Last scan resolution used
- Whether the user has been warned about missing dependencies
- Whether the user has dismissed the "update ready" notification

**Fix:**
```bash
npm install electron-store
```
```js
const Store = require('electron-store');
const store = new Store({
  schema: {
    defaultPrinter: { type: 'string', default: '' },
    scanResolution:  { type: 'number', default: 300 },
    naps2WarnShown:  { type: 'boolean', default: false },
    startAtLogin:    { type: 'boolean', default: false },
  }
});
```

---

### 1.2 — Existing Express Service

---

#### ❌ BAD-14: Business Logic Leaking Into Route Handlers

**Where it is:**
```js
// scanSession.routes.js — routes importing sleep and AIRSCAN_RETRY_DELAY_MS
const { sleep } = require('../services/scanService');
const AIRSCAN_RETRY_DELAY_MS = parseInt(process.env.AIRSCAN_RETRY_DELAY_MS) || 10000;

// and then using it in the route handler:
await sleep(AIRSCAN_RETRY_DELAY_MS);
```

**Why it's wrong:**  
Route handlers should do: validate input → call service → return response.
They should have zero knowledge of retry delays, sleep functions, or hardware timing.
This logic belongs in `scanService.js`. Moving it there means the route can't accidentally
skip it, and you can test the retry behavior without making an HTTP request.

---

#### ❌ BAD-15: `/tmp` Hardcoded — Breaks on Windows in Production

**Where it is:**
```js
// scanService.js:
const pngPattern = path.join("/tmp", `eduscan_auto_${job.id}_%03d.png`);
// autoScanJobManager.js:
path.join("/tmp", `eduscan_auto_${job.id}_...`)
```

`/tmp` does not exist on Windows. `os.tmpdir()` returns `C:\Users\<user>\AppData\Local\Temp`
on Windows. The scan service will fail silently on Windows for the auto-scan job runner.

**Fix:**
```js
const os = require('os');
const TMP_DIR = os.tmpdir();
const pngPattern = path.join(TMP_DIR, `eduscan_auto_${job.id}_%03d.png`);
```

---

## 2. Performance Bottlenecks

### PERF-01: Puppeteer Cold-Start — Already in AUDIT.md (P-01)
Confirmed critical. Every print: 3–5s browser launch penalty.
**Fix:** Browser singleton with page recycling. (Detailed in Section 6.)

### PERF-02: `scanimage -L` on Every Session Start — Already in AUDIT.md (P-03)
10+ seconds for network scanners. `SANE_DEVICE_CACHE_MS` is a dead config key.
**Fix:** Implement device cache with TTL.

### PERF-03: `Menu.buildFromTemplate()` on Every Tray State Change

**Where it is (plan):**
```js
function updateTray() {
  const contextMenu = Menu.buildFromTemplate([...]); // rebuilds entire object tree
  tray.setContextMenu(contextMenu);
}
// Called every time server status changes, every 800ms poll
```

`Menu.buildFromTemplate` creates a full native OS menu object on every call.
On Windows and Linux, this involves native UI allocations. Calling it on every
health poll cycle is wasteful.

**Fix:** Rebuild only when state actually changes. Track `lastStatus` and skip rebuild
if nothing changed. Or use `Menu.getApplicationMenu()` + update item properties
instead of rebuilding from scratch.

### PERF-04: No Browser Pool — Sequential Print Jobs Block Each Other

A single Puppeteer browser, one page at a time. Two simultaneous print requests:
request 2 waits for request 1 to finish rendering before it can even open a page.

**Fix — Simple 2-page pool:**
```js
// server/services/print/BrowserPool.js
class BrowserPool {
  #browser = null;
  #queue = [];
  #activePage = false;

  async withPage(fn) {
    if (this.#activePage) {
      // Queue the request
      await new Promise(resolve => this.#queue.push(resolve));
    }
    this.#activePage = true;
    const browser = await this.#getOrCreateBrowser();
    const page = await browser.newPage();
    try {
      return await fn(page);
    } finally {
      await page.close();
      this.#activePage = false;
      if (this.#queue.length > 0) this.#queue.shift()();
    }
  }
}
```

### PERF-05: Validation Logic Runs After Route Overhead — Should Fail Fast

All three scan routes parse and validate `resolution` and `pageCount` individually,
after the route has been matched and body parsed. A shared validation middleware
runs faster by rejecting invalid requests earlier.

---

## 3. Maintainability Issues

### MAINT-01: No Separation Between Electron and Server Layers

Currently `src/` contains the Express service. When Electron is added, `electron/`
is a sibling to `src/`. The server entry is `index.js` at root. After 6 months of
development, the root directory will contain `electron/`, `src/`, `scripts/`, `electron/main.js`,
`electron-main.js`, `index.js`, `.env`, `.env.example`, `package.json`, `AUDIT.md`,
`ELECTRON_PLAN.md`, etc.

**Fix:** Clear top-level separation:
```
electron/     ← everything Electron
server/       ← renamed from src/, plus index.js entry moved here
shared/       ← code shared between both layers
scripts/      ← build and install scripts
```

### MAINT-02: `package.json` Has No Engine Constraint

```json
// No engines field — any Node version, any npm version
```

A developer on Node 16 will get silent behavior differences from someone on Node 20.
```json
"engines": {
  "node": ">=18.0.0",
  "npm":  ">=9.0.0"
}
```

### MAINT-03: No `nodemon.json` — Dev Restart Restarts Everything

Running `npm run dev` with nodemon restarts the entire process on any file change.
In Electron development, this is especially painful — the Electron window closes and
reopens on every save.

**Fix:** Create `nodemon.json` to watch only `server/` when running the server in
dev mode independently from Electron.

### MAINT-04: `start.sh` and `start.bat` Are Not Updated by the Plan

The existing startup scripts bypass Electron entirely and launch the raw Node.js server.
After Electron packaging, these scripts become confusing — do you use the script or the app?

**Fix:** In packaged mode, `start.sh`/`start.bat` should remain for CLI/headless use.
Add a comment at the top: "For GUI use, run the installed app. This script is for
server-only headless deployment."

### MAINT-05: `preload.js` Is a No-Op — Dead File

The plan creates `electron/preload.js` that sets `window.__printScanVersion`.
This app has no `BrowserWindow`, so preload never runs. Dead file, wastes a code review.

**Fix:** Delete it. If a settings window is added later, create preload then.

---

## 4. Duplicate Logic — Full Inventory

Every item here is confirmed by `grep` on the actual source files.

| # | What | Where (file:line) | Fix |
|---|---|---|---|
| DUP-01 | `generateId()` function | `sessionManager.js:37` and `autoScanJobManager.js:41` | Move to `shared/utils/id.js` |
| DUP-02 | `sleep(ms)` function | `scanService.js:13` and `autoScanJobManager.js:45` | Move to `shared/utils/async.js` |
| DUP-03 | `cleanupPaths()` / `cleanupTempFiles()` | `autoScanJobManager.js:49` and `sessionManager.js` | Single `shared/utils/fs.js::removePaths()` |
| DUP-04 | `ensureDir` pattern | `printService.js:62`, `fileHandler.js:16`, `fileHandler.js:41` | Single `ensureDir(path)` util |
| DUP-05 | `os.platform() === 'win32'` check | `printService.js`, `printerService.js`, `scanService.js`, `autoScanJobManager.js`, `scanAuto.routes.js` | Constants: `shared/platform.js` |
| DUP-06 | `parseInt(resolution) \|\| 300` + DPI range validation | `scan.routes.js:50`, `scanSession.routes.js:44`, `scanAuto.routes.js:56` | `shared/validators.js::parseResolution()` |
| DUP-07 | `parseInt(pageCount)` + pages range validation | `scanSession.routes.js:39`, `scanAuto.routes.js:51` | `shared/validators.js::parsePageCount()` |
| DUP-08 | `isClientError` message-string check | `scan.routes.js:89` and `scanSession.routes.js:220` | `shared/errors.js::isClientError()` |
| DUP-09 | `execAsync` | defined in `scanService.js:21`, used only there | Move to `server/utils/exec.js` |
| DUP-10 | `/tmp` hardcoded | `scanService.js` and `autoScanJobManager.js` (multiple lines) | Use `os.tmpdir()` via a constant |
| DUP-11 | Cleanup timer pattern (`setInterval` + `.unref()`) | `sessionManager.js` and `autoScanJobManager.js` | Shared `createCleanupTimer(fn, ms)` |
| DUP-12 | Platform branch `linux \|\| darwin` vs `win32` | Every service file | `shared/platform.js::IS_WINDOWS`, `IS_UNIX` |

**Total: 12 confirmed duplicate patterns across 8 files.**

---

## 5. Clean Architecture Breakdown

### Proposed Directory Structure

```
print-scan-service/
│
├── electron/                          ← Electron app shell
│   ├── main.js                        ← Entry: app lifecycle ONLY (< 50 lines)
│   ├── modules/
│   │   ├── ServerManager.js           ← Child process + IPC + backoff
│   │   ├── TrayManager.js             ← Tray icon + menu rendering
│   │   ├── UpdateManager.js           ← electron-updater wrapper
│   │   ├── SettingsManager.js         ← electron-store wrapper
│   │   └── NotificationManager.js    ← OS notification helpers
│   ├── icons/
│   │   ├── icon.png                   ← 512×512 source icon
│   │   └── tray-icon.png             ← 22×22 tray icon
│   └── entitlements.mac.plist
│
├── server/                            ← Express service (was src/ + index.js)
│   ├── index.js                       ← Entry: listen + IPC ready signal
│   ├── app.js                         ← Express setup
│   ├── middleware/
│   │   ├── auth.js                    ← API key check (NEW - from AUDIT S-01)
│   │   ├── rateLimiter.js             ← express-rate-limit (NEW)
│   │   └── validateScan.js            ← Shared scan param validation (NEW)
│   ├── routes/
│   │   ├── scan.routes.js
│   │   ├── scanSession.routes.js
│   │   ├── scanAuto.routes.js
│   │   ├── print.routes.js
│   │   └── docs.routes.js
│   └── services/
│       ├── print/
│       │   ├── PrintService.js        ← Was printService.js
│       │   ├── PrinterService.js      ← Was printerService.js
│       │   └── BrowserPool.js         ← NEW: Puppeteer pool (from AUDIT P-01)
│       └── scan/
│           ├── ScanService.js         ← Was scanService.js
│           ├── SessionManager.js      ← Was sessionManager.js
│           └── AutoScanJobManager.js  ← Was autoScanJobManager.js
│
├── shared/                            ← Zero external deps; used by both layers
│   ├── platform.js                    ← IS_WINDOWS, IS_UNIX, IS_MAC constants
│   ├── validators.js                  ← parseResolution, parsePageCount, etc.
│   ├── errors.js                      ← AppError class, isClientError()
│   ├── ipc-events.js                  ← IPC message type constants
│   └── utils/
│       ├── id.js                      ← generateId() (was duplicated)
│       ├── async.js                   ← sleep(), retry(), withTimeout()
│       ├── fs.js                      ← ensureDir(), removePaths(), validateFile()
│       └── exec.js                    ← execAsync(), spawnAsync()
│
├── scripts/
│   ├── postinstall.sh
│   └── postremove.sh
│
├── electron-builder.yml               ← Build config (extracted from package.json)
├── package.json                       ← Clean: scripts + deps only
├── .env.example
├── .gitignore                         ← Must include .env (from AUDIT S-04)
├── start.sh                           ← Headless server-only startup
└── start.bat
```

### Module Responsibility Map

```
electron/main.js
  │  Bootstrap only. app.whenReady → init modules → done.
  │
  ├── ServerManager
  │     Owns: fork(), IPC channel, backoff restart, log forwarding
  │     Emits: 'ready', 'error', 'fatal', 'message'
  │     Knows nothing about: tray, UI, settings
  │
  ├── TrayManager
  │     Owns: Tray object, menu template, icon state
  │     Listens to: ServerManager events
  │     Knows nothing about: how the server works
  │
  ├── SettingsManager
  │     Owns: electron-store instance, schema
  │     Used by: all modules that need persistence
  │
  ├── UpdateManager
  │     Owns: autoUpdater setup, update notifications
  │     Listens to: autoUpdater events
  │
  └── NotificationManager
        Owns: Notification.isSupported() check, show()
        Used by: ServerManager (errors), UpdateManager (updates)
```

### IPC Message Protocol

```
server/index.js  ──process.send()──►  electron/modules/ServerManager.js
                                             │
                 ◄──serverProcess.send()──   │

Message shape: { type: string, payload?: object, timestamp: number }

Server → Electron:
  { type: 'server:ready',     payload: { port: 4545 } }
  { type: 'server:error',     payload: { message, stack } }
  { type: 'scan:started',     payload: { sessionId, totalPages } }
  { type: 'scan:page_done',   payload: { sessionId, page, remaining } }
  { type: 'scan:complete',    payload: { sessionId, filename } }
  { type: 'print:complete',   payload: { jobId, printer } }
  { type: 'print:failed',     payload: { jobId, message } }

Electron → Server:
  { type: 'shutdown' }
  { type: 'get:status' }
  { type: 'reload:config' }
```

---

## 6. Critical Problems & Solutions

### CRIT-01: Fix Duplicate Utils (DUP-01 through DUP-12)

**Create `shared/platform.js`:**
```js
// shared/platform.js
const os = require('os');

const IS_WINDOWS = os.platform() === 'win32';
const IS_MAC     = os.platform() === 'darwin';
const IS_LINUX   = os.platform() === 'linux';
const IS_UNIX    = IS_MAC || IS_LINUX;
const TMP_DIR    = os.tmpdir();

module.exports = { IS_WINDOWS, IS_MAC, IS_LINUX, IS_UNIX, TMP_DIR };
```

**Create `shared/utils/async.js`:**
```js
// shared/utils/async.js
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function retry(fn, { attempts = 3, delayMs = 1000, backoff = 1 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (err) {
      lastErr = err;
      if (i < attempts - 1) await sleep(delayMs * Math.pow(backoff, i));
    }
  }
  throw lastErr;
}

module.exports = { sleep, retry };
```

**Create `shared/utils/id.js`:**
```js
// shared/utils/id.js
const crypto = require('crypto');
const generateId = (bytes = 12) => crypto.randomBytes(bytes).toString('hex');
module.exports = { generateId };
```

**Create `shared/utils/fs.js`:**
```js
// shared/utils/fs.js
const fs = require('fs');
const path = require('path');

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function removePaths(paths = []) {
  for (const p of paths) {
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {}
  }
}

function validateFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.size > 0;
  } catch { return false; }
}

module.exports = { ensureDir, removePaths, validateFile };
```

**Create `shared/validators.js`:**
```js
// shared/validators.js

/**
 * Parse and validate DPI resolution from a route parameter.
 * @returns {{ value: number, error: string|null }}
 */
function parseResolution(raw, defaultDpi = 300) {
  const value = parseInt(raw) ?? defaultDpi;
  if (isNaN(value) || value < 72 || value > 1200) {
    return { value: null, error: 'resolution must be between 72 and 1200 DPI' };
  }
  return { value, error: null };
}

/**
 * Parse and validate page count from a route parameter.
 * @returns {{ value: number, error: string|null }}
 */
function parsePageCount(raw, { min = 1, max = 100 } = {}) {
  const value = parseInt(raw);
  if (!value || value < min || value > max) {
    return { value: null, error: `pageCount must be between ${min} and ${max}` };
  }
  return { value, error: null };
}

/**
 * Sanitize a string for use as a filename or directory component.
 */
function sanitizeName(str) {
  return String(str).replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 100);
}

module.exports = { parseResolution, parsePageCount, sanitizeName };
```

**Create `shared/errors.js`:**
```js
// shared/errors.js
class AppError extends Error {
  constructor(message, { statusCode = 500, code = 'INTERNAL_ERROR' } = {}) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

class ClientError extends AppError {
  constructor(message, code = 'BAD_REQUEST') {
    super(message, { statusCode: 422, code });
  }
}

function isClientError(err) {
  if (err instanceof ClientError) return true;
  const msg = err.message?.toLowerCase() ?? '';
  return (
    msg.includes('not found') ||
    msg.includes('not installed') ||
    msg.includes('not connected') ||
    msg.includes('unsupported platform') ||
    msg.includes('face-down')
  );
}

module.exports = { AppError, ClientError, isClientError };
```

---

### CRIT-02: Proper ServerManager Class

**`electron/modules/ServerManager.js`:**
```js
// electron/modules/ServerManager.js
'use strict';

const { fork }        = require('child_process');
const { EventEmitter } = require('events');
const path            = require('path');
const fs              = require('fs');
const log             = require('electron-log');
const IPC             = require('../../shared/ipc-events');

const MAX_RESTARTS = 5;
const BASE_DELAY_MS = 2000;

class ServerManager extends EventEmitter {
  #process       = null;
  #isQuitting    = false;
  #restartCount  = 0;
  #serverEntry   = null;
  #env           = {};

  constructor({ serverEntry, env = {} }) {
    super();
    this.#serverEntry = serverEntry;
    this.#env = env;
  }

  get isRunning() {
    return this.#process !== null && this.#process.exitCode === null;
  }

  start() {
    if (this.isRunning) return;

    log.info(`[ServerManager] Starting server (attempt ${this.#restartCount + 1})`);

    this.#process = fork(this.#serverEntry, [], {
      cwd:    path.dirname(this.#serverEntry),
      silent: true,                              // pipe stdout/stderr
      env:    { ...process.env, ...this.#env, ELECTRON_FORKED: '1' },
    });

    // Forward server stdout/stderr to electron-log
    this.#process.stdout.on('data', (d) =>
      d.toString().split('\n').filter(Boolean).forEach(l => log.info(`[server] ${l}`))
    );
    this.#process.stderr.on('data', (d) =>
      d.toString().split('\n').filter(Boolean).forEach(l => log.error(`[server] ${l}`))
    );

    // Handle typed IPC messages from server
    this.#process.on('message', (msg) => {
      if (!msg?.type) return;
      log.debug(`[ServerManager] IPC received: ${msg.type}`);
      if (msg.type === IPC.SERVER_READY) {
        this.#restartCount = 0;
        this.emit('ready', msg.payload);
      } else {
        this.emit('message', msg);
      }
    });

    this.#process.on('error', (err) => {
      log.error(`[ServerManager] Process error: ${err.message}`);
      this.emit('error', err);
    });

    this.#process.on('exit', (code, signal) => {
      log.warn(`[ServerManager] Server exited (code=${code}, signal=${signal})`);
      this.#process = null;
      this.emit('exit', code);
      if (!this.#isQuitting) this.#scheduleRestart();
    });
  }

  stop() {
    if (!this.isRunning) return;
    this.send({ type: IPC.SHUTDOWN });
    setTimeout(() => {
      if (this.isRunning) this.#process.kill('SIGTERM');
    }, 3000);
  }

  send(message) {
    if (this.isRunning) {
      this.#process.send({ ...message, timestamp: Date.now() });
    }
  }

  quit() {
    this.#isQuitting = true;
    this.stop();
  }

  restart() {
    this.#restartCount = 0; // manual restart resets backoff
    this.stop();
    setTimeout(() => this.start(), 500);
  }

  #scheduleRestart() {
    if (this.#restartCount >= MAX_RESTARTS) {
      const msg = `Server failed to start after ${MAX_RESTARTS} attempts. Check logs at ${log.transports.file.getFile().path}`;
      log.error(`[ServerManager] ${msg}`);
      this.emit('fatal', msg);
      return;
    }
    const delay = BASE_DELAY_MS * Math.pow(2, this.#restartCount);
    log.warn(`[ServerManager] Restart ${this.#restartCount + 1}/${MAX_RESTARTS} in ${delay}ms`);
    this.#restartCount++;
    setTimeout(() => this.start(), delay);
  }
}

module.exports = ServerManager;
```

---

### CRIT-03: Clean TrayManager

**`electron/modules/TrayManager.js`:**
```js
// electron/modules/TrayManager.js
'use strict';

const { Tray, Menu, nativeImage, shell } = require('electron');
const path = require('path');
const log  = require('electron-log');

const ICONS_DIR = path.join(__dirname, '..', 'icons');

class TrayManager {
  #tray       = null;
  #state      = { status: 'starting', port: 4545, activeSessions: 0 };
  #onQuit     = null;
  #onRestart  = null;
  #onSettings = null;
  #store      = null;

  constructor({ store, onQuit, onRestart }) {
    this.#store     = store;
    this.#onQuit    = onQuit;
    this.#onRestart = onRestart;
  }

  create() {
    const iconPath = path.join(ICONS_DIR, 'tray-icon.png');
    const icon = nativeImage.createFromPath(iconPath).resize({ width: 22, height: 22 });
    if (process.platform === 'darwin') icon.setTemplateImage(true);

    this.#tray = new Tray(icon);
    this.#tray.setToolTip('Print & Scan Service');
    this.#tray.on('click', () => {
      if (this.#state.status === 'ready') {
        shell.openExternal(`http://localhost:${this.#state.port}`);
      }
    });
    this.#render();
  }

  setState(patch) {
    const prev = JSON.stringify(this.#state);
    this.#state = { ...this.#state, ...patch };
    if (JSON.stringify(this.#state) !== prev) this.#render(); // only re-render on change
  }

  #render() {
    if (!this.#tray) return;
    const { status, port, activeSessions } = this.#state;
    const isReady = status === 'ready';

    const template = [
      { label: 'Print & Scan Service',                        enabled: false },
      { label: isReady ? `● Running — port ${port}` : '○ Starting…', enabled: false },
      activeSessions > 0
        ? { label: `  ${activeSessions} active scan session(s)`, enabled: false }
        : null,
      { type: 'separator' },
      { label: 'Open Docs', enabled: isReady,
        click: () => shell.openExternal(`http://localhost:${port}/`) },
      { label: 'API Health Check', enabled: isReady,
        click: () => shell.openExternal(`http://localhost:${port}/api/health`) },
      { type: 'separator' },
      { label: 'Restart Service', click: this.#onRestart },
      { type: 'separator' },
      { label: 'Start at Login', type: 'checkbox',
        checked: this.#store.get('startAtLogin', false),
        click: (item) => {
          this.#store.set('startAtLogin', item.checked);
          require('electron').app.setLoginItemSettings({ openAtLogin: item.checked });
        }
      },
      { label: 'View Logs',
        click: () => require('electron').shell.openPath(
          require('electron-log').transports.file.getFile().path
        )
      },
      { type: 'separator' },
      { label: 'Quit', click: this.#onQuit },
    ].filter(Boolean); // remove nulls

    this.#tray.setContextMenu(Menu.buildFromTemplate(template));
  }
}

module.exports = TrayManager;
```

---

### CRIT-04: Clean `electron/main.js` — Bootstrap Only

```js
// electron/main.js  — under 60 lines, bootstrap only
'use strict';

const { app }          = require('electron');
const path             = require('path');
const log              = require('electron-log');
const Store            = require('electron-store');
const ServerManager    = require('./modules/ServerManager');
const TrayManager      = require('./modules/TrayManager');
const NotificationManager = require('./modules/NotificationManager');
const UpdateManager    = require('./modules/UpdateManager');
const { IS_MAC }       = require('../shared/platform');

// ── Single instance lock ────────────────────────────────────────────────────
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

// ── Logging ─────────────────────────────────────────────────────────────────
log.transports.file.level = 'info';
log.info('App starting —', app.getVersion());

// ── Modules ─────────────────────────────────────────────────────────────────
const store   = new Store({ /* schema from CRIT section */ });
const notify  = new NotificationManager();

const serverEntry = app.isPackaged
  ? path.join(process.resourcesPath, 'app', 'server', 'index.js')
  : path.join(__dirname, '..', 'server', 'index.js');

const scansDir = path.join(app.getPath('userData'), 'scans');

const server = new ServerManager({
  serverEntry,
  env: { SCANS_DIR: scansDir, PORT: '4545' },
});

const tray = new TrayManager({
  store,
  onQuit:    () => { server.quit(); app.quit(); },
  onRestart: () => server.restart(),
});

// ── Wire events ─────────────────────────────────────────────────────────────
server.on('ready',   (p) => { tray.setState({ status: 'ready', port: p.port }); notify.send('Running', `Service ready on port ${p.port}`); });
server.on('exit',    ()  =>   tray.setState({ status: 'starting' }));
server.on('fatal',   (m) =>   notify.send('Service Failed', m));
server.on('message', (m) => {
  if (m.type === 'scan:started')  tray.setState({ activeSessions: (tray.state?.activeSessions ?? 0) + 1 });
  if (m.type === 'scan:complete') tray.setState({ activeSessions: Math.max(0, (tray.state?.activeSessions ?? 1) - 1) });
});

// ── Lifecycle ────────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  if (IS_MAC) app.dock.hide();
  tray.create();
  server.start();
  UpdateManager.init(notify);
});

app.on('window-all-closed', (e) => e.preventDefault());
app.on('second-instance',   ()  => require('electron').shell.openExternal('http://localhost:4545'));
app.on('before-quit',       ()  => server.quit());
```

---

### CRIT-05: Validation Middleware — Eliminate Route Duplication

**`server/middleware/validateScan.js`:**
```js
// server/middleware/validateScan.js
const { parseResolution, parsePageCount, sanitizeName } = require('../../shared/validators');

/**
 * Validates resolution and optional pageCount from req.body or req.query.
 * Attaches parsed values to req.scan for the route handler.
 */
function validateScanParams(req, res, next) {
  const source = req.method === 'GET' ? req.query : req.body;

  const examCode = source.examCode?.trim();
  if (!examCode) {
    return res.status(400).json({ success: false, message: 'Missing required field: examCode' });
  }

  const { value: dpi, error: dpiErr } = parseResolution(source.resolution);
  if (dpiErr) return res.status(400).json({ success: false, message: dpiErr });

  req.scan = {
    examCode:  sanitizeName(examCode),
    uniqueId:  source.uniqueId?.trim() ? sanitizeName(source.uniqueId.trim()) : null,
    resolution: dpi,
  };
  next();
}

function validatePageCount(req, res, next) {
  const { value: pages, error } = parsePageCount(req.body?.pageCount);
  if (error) return res.status(400).json({ success: false, message: error });
  req.scan = { ...req.scan, totalPages: pages };
  next();
}

module.exports = { validateScanParams, validatePageCount };
```

Now every route shrinks to:
```js
// Before: 15 lines of validation per route
// After:
router.post('/scan/start',
  validateScanParams,
  validatePageCount,
  async (req, res) => {
    const { examCode, uniqueId, resolution, totalPages } = req.scan;
    // ... business logic only
  }
);
```

---

## 7. Production-Grade Implementation Plan

**Claude Code: Implement in this exact order. Run `npm run electron` after each phase.**

---

### Phase 0 — Prepare (30 min)

```bash
# Install all new dependencies
npm install electron electron-log electron-store --save
npm install electron-builder --save-dev
npm uninstall electron-squirrel-startup  # remove the wrong package from plan

# Verify
node -e "require('electron-log'); console.log('OK')"
node -e "require('electron-store'); console.log('OK')"
```

---

### Phase 1 — Create Shared Utilities (Eliminate All Duplicates)

**Files to create, in order:**

1. `shared/platform.js` — IS_WINDOWS, IS_MAC, IS_LINUX, IS_UNIX, TMP_DIR
2. `shared/utils/id.js` — generateId()
3. `shared/utils/async.js` — sleep(), retry()
4. `shared/utils/fs.js` — ensureDir(), removePaths(), validateFile()
5. `shared/utils/exec.js` — execAsync(), spawnAsync()
6. `shared/validators.js` — parseResolution(), parsePageCount(), sanitizeName()
7. `shared/errors.js` — AppError, ClientError, isClientError()
8. `shared/ipc-events.js` — IPC constants object

**Then update existing service files to import from shared:**
- `sessionManager.js` → remove `generateId()`, import from `shared/utils/id.js`
- `autoScanJobManager.js` → remove `generateId()`, `sleep()`, `cleanupPaths()`, import from shared
- `scanService.js` → remove `sleep()`, `execAsync()`, import from shared; replace `/tmp` with `TMP_DIR`
- `fileHandler.js` → remove inline `ensureDir` pattern, import `ensureDir` from shared
- `printService.js` → remove `ensureTempDir()`, use shared `ensureDir`; replace platform checks with `IS_WINDOWS`

**Verify:** `grep -r "require.*os" src/` should return zero results after this phase.

---

### Phase 2 — Server Restructure

1. **Move `src/` → `server/`**  
   ```bash
   mv src server
   ```
   Update all `require('../src/...')` and `require('./src/...')` references.

2. **Move `index.js` → `server/index.js`**  
   Update entry in `package.json`: `"start": "node server/index.js"`

3. **Add IPC ready signal to `server/index.js`:**
   ```js
   app.listen(PORT, () => {
     logger.info(`Service running on port ${PORT}`);
     // Signal Electron parent if running as child process
     if (process.send) {
       process.send({ type: 'server:ready', payload: { port: Number(PORT) }, timestamp: Date.now() });
     }
   });
   ```

4. **Add graceful shutdown IPC handler:**
   ```js
   process.on('message', (msg) => {
     if (msg?.type === 'shutdown') {
       logger.info('Shutdown signal received from Electron');
       process.exit(0);
     }
   });
   ```

5. **Create middleware:**
   - `server/middleware/auth.js` (from AUDIT S-01)
   - `server/middleware/rateLimiter.js` (from AUDIT S-03 note)
   - `server/middleware/validateScan.js` (from CRIT-05 above)

6. **Refactor routes** to use `validateScan` middleware. Remove all inline validation.

---

### Phase 3 — Electron Layer

1. **Create `electron/modules/ServerManager.js`** — full code from CRIT-02
2. **Create `electron/modules/TrayManager.js`** — full code from CRIT-03
3. **Create `electron/modules/SettingsManager.js`:**
   ```js
   const Store = require('electron-store');
   module.exports = new Store({
     schema: {
       startAtLogin:   { type: 'boolean', default: false },
       naps2WarnShown: { type: 'boolean', default: false },
       defaultPrinter: { type: 'string',  default: '' },
       scanResolution: { type: 'number',  default: 300 },
     }
   });
   ```
4. **Create `electron/modules/NotificationManager.js`:**
   ```js
   const { Notification } = require('electron');
   const log = require('electron-log');
   class NotificationManager {
     send(title, body) {
       if (!Notification.isSupported()) { log.info(`[notify] ${title}: ${body}`); return; }
       new Notification({ title, body }).show();
     }
   }
   module.exports = NotificationManager;
   ```
5. **Create `electron/modules/UpdateManager.js`:**
   ```js
   const { autoUpdater } = require('electron-updater');
   const log = require('electron-log');
   module.exports = {
     init(notify) {
       autoUpdater.logger = log;
       autoUpdater.on('update-downloaded', () =>
         notify.send('Update Ready', 'Restart to install the latest version.')
       );
       setTimeout(() => autoUpdater.checkForUpdatesAndNotify().catch(() => {}), 10_000);
     }
   };
   ```
6. **Create `electron/main.js`** — clean bootstrap from CRIT-04
7. **Delete** `electron-main.js` (root alias — no longer needed)
8. **Update `package.json`:** `"main": "electron/main.js"`

---

### Phase 4 — Build Configuration

**Create `electron-builder.yml`** (extract from package.json):
```yaml
appId: com.yourdomain.print-scan-service
productName: "Print & Scan Service"
copyright: "Copyright © 2026"
asar: true
asarUnpack:
  - "server/node_modules/puppeteer/**"
  - "server/node_modules/pdf-to-printer/**"
files:
  - "electron/**"
  - "server/**"
  - "shared/**"
  - "!**/*.map"
  - "!**/test/**"
  - "!**/.git/**"
icon: "electron/icons/icon"
win:
  target:
    - target: nsis
      arch: [x64]
    - target: portable
      arch: [x64]
nsis:
  oneClick: false
  allowToChangeInstallationDirectory: true
  createDesktopShortcut: true
  runAfterFinish: true
linux:
  target:
    - target: AppImage
      arch: [x64]
    - target: deb
      arch: [x64]
  category: Utility
mac:
  target:
    - target: dmg
      arch: [x64, arm64]
  category: public.app-category.utilities
  hardenedRuntime: true
  entitlements: electron/entitlements.mac.plist
  entitlementsInherit: electron/entitlements.mac.plist
publish:
  provider: github
  owner: your-github-username
  repo: print-scan-service
```

**Remove the entire `"build"` key from `package.json`.**

---

### Phase 5 — Quality Checks

```bash
# 1. Verify no more /tmp hardcoding:
grep -rn '"/tmp"' server/ shared/    # should be 0 results

# 2. Verify no more duplicate generateId:
grep -rn "function generateId\|crypto.randomBytes" server/  # only in shared/

# 3. Verify no more platform string duplication:
grep -rn "platform.*win32\|os.platform" server/   # should be 0 (all via shared/platform.js)

# 4. Verify no more inline DPI validation in routes:
grep -rn "parseInt.*resolution\|dpi.*<.*72" server/routes/  # should be 0

# 5. Run the server standalone:
node server/index.js
curl http://localhost:4545/api/health

# 6. Run in Electron dev mode:
npm run electron

# 7. Build for current platform:
npm run build:win    # on Windows
npm run build:linux  # on Linux
npm run build:mac    # on macOS
```

---

### Phase 6 — Final `package.json`

Clean version after all changes:
```json
{
  "name": "print-scan-service",
  "version": "1.0.0",
  "description": "Silent print and scan local API service",
  "main": "electron/main.js",
  "engines": { "node": ">=18.0.0", "npm": ">=9.0.0" },
  "scripts": {
    "start":        "node server/index.js",
    "dev":          "nodemon server/index.js",
    "electron":     "electron .",
    "build:win":    "electron-builder --win",
    "build:linux":  "electron-builder --linux",
    "build:mac":    "electron-builder --mac"
  },
  "dependencies": {
    "cors":           "^2.8.5",
    "dotenv":         "^16.4.5",
    "electron-log":   "^5.x",
    "electron-store": "^8.x",
    "express":        "^4.19.2",
    "express-rate-limit": "^7.x",
    "marked":         "^17.0.5",
    "morgan":         "^1.10.0",
    "pdf-to-printer": "^5.7.0",
    "puppeteer":      "^24.40.0",
    "uuid":           "^13.0.0",
    "winston":        "^3.13.0",
    "winston-daily-rotate-file": "^5.x"
  },
  "devDependencies": {
    "electron":         "^31.x",
    "electron-builder": "^24.x",
    "nodemon":          "^3.1.4"
  }
}
```

---

## Summary — What Changed and Why

| Before | After | Reason |
|---|---|---|
| 1 monolithic `electron/main.js` (200+ lines) | 5 focused modules (<80 lines each) | SRP, testability |
| HTTP poll for server readiness | IPC `process.send()` message | Instant, zero overhead |
| `silent: false` — logs lost in prod | `silent: true` + piped to `electron-log` | Operational visibility |
| `electron-squirrel-startup` + NSIS | NSIS only (correct match) | Remove incompatible package |
| `scans/` in app bundle | `app.getPath('userData')/scans` | Writable on all platforms |
| `.env` copy in `startServer()` | One-time in `whenReady()` | Runs once, not on every restart |
| NAPS2 dialog every startup | `electron-store` flag (shows once) | Not annoying |
| 3s flat restart delay | Exponential backoff, max 5 attempts | Prevents infinite crash loop |
| No IPC protocol | Typed message schema in `shared/ipc-events.js` | Tray sees real server state |
| 12 duplicate code patterns | All moved to `shared/` | Single source of truth |
| `/tmp` hardcoded | `os.tmpdir()` via `shared/platform.js` | Works on Windows |
| Validation in every route | `validateScan` middleware | DRY, consistent errors |
| Build config in `package.json` | `electron-builder.yml` | Readable, maintainable |
| `console.log` in Electron | `electron-log` | Survives packaging |
| No settings persistence | `electron-store` | Remembers user preferences |

---

*End of Architecture Review · August 2026*
