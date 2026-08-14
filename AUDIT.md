# Technical Audit Report — Print & Scanning Local Service

**Service:** `scaning-nodejs` · Node.js + Express · v1.0.0  
**Auditor:** Senior Engineering Review  
**Date:** August 2026  
**Scope:** Full codebase — security, performance, reliability, code quality

---

## Overall Health Scorecard

| Area | Score | Status |
|---|---|---|
| Security | 3 / 10 | 🔴 Critical |
| Performance | 5 / 10 | 🟠 Needs Work |
| Reliability | 5 / 10 | 🟠 Needs Work |
| Code Quality | 7 / 10 | 🟡 Good |
| Cross-Platform Support | 6 / 10 | 🟡 Good |
| API Design | 7 / 10 | 🟢 Good |
| Error Handling | 7 / 10 | 🟢 Good |
| Logging & Ops | 7 / 10 | 🟢 Good |

> **VERDICT:** Solid proof-of-concept with good structure and thoughtful multi-page scanning design. NOT production-safe as-is. The two biggest killers: (1) zero authentication — any machine or website can print/scan, (2) Puppeteer cold-start on every print — adds 3–5 seconds per job. Fix these first, then reliability items, and this becomes a dependable production service.

---

## 1. Architecture Overview

The service is a single-process Node.js (Express) app on port 4545. Websites call this local HTTP API to perform silent printing and document scanning without any browser print dialog. It bridges the web to OS-level printer spoolers (CUPS on Linux/macOS, `pdf-to-printer` on Windows) and scanner backends (SANE/`scanimage` on Linux/macOS, NAPS2 on Windows).

### 1.1 Print Pipeline

```
POST /api/print
  → Puppeteer renders HTML to PDF (headless Chrome)
  → lp / pdf-to-printer sends PDF to OS spooler
  → temp PDF deleted
  → HTTP 200 returned
```

Entire pipeline is **synchronous within the request** — response only sends after OS accepts the job.

### 1.2 Scan Pipelines (three modes)

| Mode | Endpoint | Mechanism |
|---|---|---|
| Single-page | `GET /api/scan` | `scanimage` → PNG → ImageMagick → PDF |
| Multi-page session | `POST /api/scan/start` → `page` → `complete` | One persistent `scanimage --batch --batch-prompt` process; pages triggered via `stdin` write |
| Auto ADF | `POST /api/scan/auto/start` | `scanimage --batch --source ADF` in background; client polls `GET /api/scan/auto/:jobId` |

### 1.3 Key Dependencies

| Dependency | Purpose |
|---|---|
| Express 4.19 | HTTP server |
| Puppeteer 24 | HTML → PDF rendering (headless Chromium) |
| pdf-to-printer 5.7 | Windows print spooler integration |
| scanimage (SANE) | Linux/macOS scanner driver interface |
| ImageMagick | PNG → PDF conversion |
| NAPS2 CLI | Windows scanner (external, not an npm dep) |
| Winston 3 + Morgan | Structured logging + HTTP request logging |
| crypto.randomBytes | Session IDs |
| uuid v4 | Print job IDs |

---

## 2. Security Issues 🔴

> These expose the service or host machine to unauthorized access. Fix before any multi-user or network-accessible deployment.

---

### S-01 — No Authentication — Completely Open API `[CRITICAL]`

**Impact:** Any process on the local network (or any website the user visits, via the wildcard CORS policy) can print arbitrary documents or trigger repeated scans. No API key, no token, no session check.

**Detail:** `app.js` sets `cors({ origin: '*' })`. `print.routes.js` and `scan.routes.js` have zero auth middleware. An attacker who knows port 4545 can print thousands of pages or fill the disk with scan files.

**Fix:**
```js
// middleware/auth.js
const API_KEY = process.env.SCAN_API_KEY;

module.exports = (req, res, next) => {
  if (!API_KEY) return next(); // disabled if not configured
  if (req.headers['x-api-key'] !== API_KEY) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  next();
};

// app.js — apply to all /api/* except health
const auth = require('./middleware/auth');
app.use('/api/scan', auth, scanRoutes);
app.use('/api/print', auth, printRoutes);
// GET /api/health stays open intentionally
```

Add to `.env`:
```
SCAN_API_KEY=generate-a-long-random-secret-here
```

---

### S-02 — CORS Wildcard `origin:'*'` — CSRF from Any Website `[CRITICAL]`

**Impact:** Any website the user has open in their browser can silently trigger a real physical print job via `POST /api/print`. The user sees no dialog.

**Detail:** With `origin:'*'` the browser doesn't apply the same-origin policy. Since the service has no auth (S-01), any malicious iframe on any page the user visits can print or scan.

**Fix:**
```js
// app.js
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'],
  methods: ['GET', 'POST', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Api-Key'],
}));
```

Add to `.env`:
```
ALLOWED_ORIGINS=https://yoursite.com,http://localhost:3000
```

---

### S-03 — Arbitrary HTML Passed to Puppeteer — Local File Access Risk `[HIGH]`

**Impact:** The print endpoint accepts any HTML string and renders it in headless Chrome, which has access to `file://` URLs. Combined with `--no-sandbox`, malicious HTML can attempt to read local files.

**Detail:** `page.setContent(html, ...)` places untrusted caller HTML into a Chrome tab. The `--no-sandbox` flag weakens Chrome's security model.

**Fix:**
```js
// printService.js — inside convertHtmlToPdf, before page.setContent
await page.setRequestInterception(true);
page.on('request', (request) => {
  const url = request.url();
  if (url.startsWith('file://') || url.startsWith('data:')) {
    request.abort();
  } else {
    request.continue();
  }
});

// Inject CSP before rendering
const safeHtml = html.replace(
  '<head>',
  `<head><meta http-equiv="Content-Security-Policy" content="default-src 'self' 'unsafe-inline' https:; object-src 'none';">`
);
await page.setContent(safeHtml, { waitUntil: 'networkidle2', timeout: 30000 });
```

---

### S-04 — `.env` Not in `.gitignore` — Secrets Will Be Committed `[HIGH]`

**Impact:** PRINTER_NAME, SANE_DEVICE, SCANS_DIR, and any future API keys become public if the repo is pushed to a remote.

**Detail:** `.gitignore` currently only lists `node_modules/` and `logs/`. The `.env` file is unprotected.

**Fix:**
```bash
# Immediate actions:
echo ".env" >> .gitignore
cp .env .env.example
# Edit .env.example to replace real values with placeholders
git rm --cached .env 2>/dev/null || true
git add .gitignore .env.example
git commit -m "chore: remove .env from tracking, add .env.example"
```

---

### S-05 — Shell Injection in `buildLinuxScanCommand` via `exec()` `[MEDIUM]`

**Impact:** A device name containing shell metacharacters (backtick, `$`, semicolon) passed to `exec()` could execute arbitrary commands.

**Detail:** `buildLinuxScanCommand` builds a string like `scanimage --device-name="..."  && convert ...` and passes it to `exec()`. Device names are quoted but not escaped. Device names come from `scanimage -L`, but a rogue mDNS device could inject a crafted name.

**Fix:** Migrate `scanSinglePage` to `spawn` with an args array — the same pattern already used correctly in `spawnBatchProcess`. Never pass user-influenced strings to `exec()`.

---

## 3. Performance Issues 🟠

---

### P-01 — Puppeteer Cold-Start per Print Job — 3–5 Second Penalty Every Print `[CRITICAL]`

**Impact:** Every `POST /api/print` launches a fresh Chrome process. 10 print jobs = 30–50 seconds of browser launches before any paper moves.

**Detail:** `convertHtmlToPdf` calls `puppeteer.launch()` on every invocation. Puppeteer 24 with bundled Chromium takes 2–4 seconds to start.

**Fix — Browser Singleton:**
```js
// printService.js

let _browser = null;

async function getBrowser() {
  if (_browser) {
    try {
      // Check it's still alive
      await _browser.version();
      return _browser;
    } catch {
      _browser = null;
    }
  }
  _browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
  });
  return _browser;
}

// In convertHtmlToPdf — replace puppeteer.launch() with:
const browser = await getBrowser();
const page = await browser.newPage();
try {
  await page.setContent(html, { waitUntil: 'networkidle2', timeout: 30000 });
  await page.pdf({ path: pdfPath, ...config });
} finally {
  await page.close(); // close page, NOT browser
}

// In graceful shutdown (index.js):
process.on('SIGTERM', async () => {
  if (_browser) await _browser.close();
  process.exit(0);
});
```

**Result:** Print latency drops from 3–5s to under 500ms per job.

---

### P-02 — `waitUntil: 'networkidle0'` Blocks on External Resources `[HIGH]`

**Impact:** If HTML references any CDN font, image, or analytics pixel, Puppeteer waits up to 30 seconds for all connections to close before generating the PDF.

**Detail:** `networkidle0` = wait until zero active connections for 500ms. The most conservative setting possible.

**Fix:**
```js
// For self-contained exam/OMR HTML (no external resources):
await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 15000 });

// For HTML that may have CDN fonts/images:
await page.setContent(html, { waitUntil: 'networkidle2', timeout: 20000 });
```

---

### P-03 — `scanimage -L` Re-Run on Every Session Start — 10+ Seconds for Network Scanners `[HIGH]`

**Impact:** Every `POST /api/scan/start` and `POST /api/scan/auto/start` loses 8–12 seconds to device discovery before the scanner even opens.

**Detail:** `detectLinuxDeviceForced()` always runs `scanimage -L` from scratch. The `.env` file defines `SANE_DEVICE_CACHE_MS=300000` but **this variable is never read in the code** — it's a dead config key.

**Fix — Implement the Cache:**
```js
// scanService.js — add at module scope:
let _deviceCache = { device: null, expiresAt: 0 };

async function detectLinuxDeviceForced() {
  const cacheMs = parseInt(process.env.SANE_DEVICE_CACHE_MS) || 300_000;
  if (_deviceCache.device && Date.now() < _deviceCache.expiresAt) {
    logger.info(`Using cached SANE device: ${_deviceCache.device}`);
    return _deviceCache.device;
  }

  // ... existing scanimage -L logic ...

  _deviceCache = { device: detected, expiresAt: Date.now() + cacheMs };
  return detected;
}

// Invalidate cache on device-open failure:
function invalidateDeviceCache() {
  _deviceCache = { device: null, expiresAt: 0 };
}
```

---

### P-04 — No Scanner Mutex — Concurrent Requests Cause Hardware Conflicts `[HIGH]`

**Impact:** Two simultaneous `POST /api/scan/start` calls open two `scanimage` processes against the same physical device. Both fail, or one corrupts the other's scan.

**Fix:**
```js
// scanService.js — simple promise queue mutex:
let _scanLock = Promise.resolve();

function withScannerLock(fn) {
  const next = _scanLock.then(fn);
  _scanLock = next.catch(() => {}); // prevent lock poisoning
  return next;
}

// scanSession.routes.js — wrap the batch process spawn:
router.post('/scan/start', async (req, res) => {
  // ... validation ...
  return withScannerLock(async () => {
    // ... existing session creation and batch spawn ...
  }).catch(err => {
    if (err.message === 'SCANNER_BUSY') {
      return res.status(503).set('Retry-After', '5').json({
        success: false, message: 'Scanner is busy. Retry in 5 seconds.'
      });
    }
    throw err;
  });
});
```

---

### P-05 — ImageMagick PNG-to-PDF is Slow and Blocked by `policy.xml` `[HIGH]` — ✅ RESOLVED

**Resolution:** ImageMagick removed entirely. `combinePagesToPdf`, `convertPngToPdf`, and `executeScan`'s legacy single-shot path now use `sharp` (PNG→JPEG recompression, same `SCAN_QUALITY`) + `pdf-lib` (in-process PDF assembly) instead of the `img2pdf` fix suggested below — this team doesn't use Python elsewhere, so a Node-only, npm-installed replacement was chosen instead of adding a Python/pip dependency. `checkPageDimensions` and `handleScanError`'s policy.xml branch were updated accordingly. See `docs/pdf-generation-migration.html` for the full breakdown.

**Impact:** 2–4 seconds per page. Blocked by default on Ubuntu/Debian. A 10-page scan adds 20–40 seconds of conversion time.

**Detail:** `combinePagesToPdf` and `convertPngToPdf` call ImageMagick via `exec()`. The service already has a `handleScanError` case for the policy.xml block — meaning this failure is expected and recurring.

**Fix — Replace with `img2pdf`:**
```bash
pip install img2pdf
```

```js
// scanService.js
async function combinePagesToPdf(pngPaths, outputPdfPath) {
  const quoted = (p) => `"${p}"`;
  const sources = pngPaths.map(quoted).join(' ');
  const cmd = `img2pdf ${sources} -o ${quoted(outputPdfPath)}`;
  logger.info(`Combining ${pngPaths.length} pages into PDF: ${outputPdfPath}`);
  await execAsync(cmd);
}

async function convertPngToPdf(pngPath, outputPdfPath) {
  await execAsync(`img2pdf "${pngPath}" -o "${outputPdfPath}"`);
}
```

`img2pdf` wraps PNGs in a PDF without re-encoding or invoking Ghostscript. No `policy.xml` issues. Runtime: under 0.5s for 10 pages.

---

## 4. Reliability & Stability Issues 🟠

---

### R-01 — Two Dead Env Vars — Documented Features That Don't Exist in Code `[HIGH]`

**Impact:** Operators who configure these believe they are changing real behavior. They are not.

**Dead variables:**
- `SANE_DEVICE_CACHE_MS` — documented as a 5-minute device-list cache. **Never read in code.**
- `AIRSCAN_RETRY_DELAY_MS` — documented as a delay before retrying after airscan session conflict. **Never read in code.**

**Verify:**
```bash
grep -r "SANE_DEVICE_CACHE_MS" src/   # → 0 results
grep -r "AIRSCAN_RETRY_DELAY_MS" src/ # → 0 results
```

**Fix:** Implement both (see P-03 for cache). For retry delay:
```js
// In scan error recovery path, when device open fails:
const retryDelayMs = parseInt(process.env.AIRSCAN_RETRY_DELAY_MS) || 10_000;
logger.warn(`Device open failed. Waiting ${retryDelayMs}ms before retry...`);
await sleep(retryDelayMs);
// retry once
```

---

### R-02 — `waitForBatchReady` Silently Assumes Ready After 10s `[HIGH]`

**Impact:** If the scanner doesn't print `"Place document... Press RETURN"` within 10 seconds, the service returns `200 OK` anyway. The subsequent page scan call then fails with a confusing error.

**Detail:** The 10-second fallback timer calls `settle(null)` — success — without checking if the process already exited with an error.

**Fix:**
```js
// In waitForBatchReady, replace the fallback timer:
const timer = setTimeout(() => {
  if (!settled) {
    if (child.exitCode !== null) {
      settle(new Error(
        `Batch process exited (code ${child.exitCode}) before readiness prompt. ` +
        `Last output: ${lastStderr || 'none'}`
      ));
    } else {
      logger.warn('waitForBatchReady: readiness prompt not received — assuming ready (check scanner)');
      settle(null);
    }
  }
}, READY_TIMEOUT_MS);
```

---

### R-03 — All Session/Job State Is In-Memory — Lost on Restart `[MEDIUM]`

**Impact:** A service crash or restart wipes all active sessions. Clients get 404. Orphaned temp PNG files remain in `/tmp` with no session to clean them up.

**Fix — Persist to disk:**
```js
// sessionManager.js — save on every mutation:
const SESSION_FILE = path.join(process.env.SCANS_DIR || './scans', '.sessions.json');

function persistSessions() {
  const data = {};
  for (const [id, s] of sessions) {
    // Don't serialize the child process handle
    data[id] = { ...s, batchProcess: null };
  }
  fs.writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2));
}

function loadSessions() {
  try {
    if (!fs.existsSync(SESSION_FILE)) return;
    const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    for (const [id, s] of Object.entries(data)) {
      // Only recover sessions whose temp files still exist
      const allFilesExist = s.scannedPages.every(p => fs.existsSync(p));
      if (allFilesExist) sessions.set(id, { ...s, batchProcess: null });
    }
  } catch (err) {
    logger.warn(`Session recovery failed: ${err.message}`);
  }
}

// Call loadSessions() at module load
loadSessions();
// Call persistSessions() after every createSession / removeSession
```

---

### R-04 — `detectImageMagick` Race Condition at Startup `[MEDIUM]` — ✅ MOOT

**Resolution:** ImageMagick was removed entirely as part of P-05 (above) — `IM_COMMAND` and `detectImageMagick()` no longer exist in `scanService.js`, so this race condition can't occur.

**Impact:** If a scan arrives within the first ~500ms of startup, `IM_COMMAND` is still `'convert'` even on ImageMagick 7 systems where `'magick'` is correct. First scan fails.

**Detail:** `detectImageMagick()` fires an async `exec()` callback without returning a promise. `scanService.js` is required before the callback fires.

**Fix — Use `execSync` at module load:**
```js
// scanService.js — replace detectImageMagick():
let IM_COMMAND;
try {
  require('child_process').execSync('magick -version', { stdio: 'ignore' });
  IM_COMMAND = 'magick';
  logger.info('ImageMagick 7+ detected, using "magick" command.');
} catch {
  IM_COMMAND = 'convert';
  logger.info('Using "convert" command (ImageMagick 6 or older).');
}
```

---

### R-05 — No Graceful Shutdown — Orphans Scan Processes and Temp Files `[HIGH]`

**Impact:** Hard stop leaves `scanimage` running, holding the eSCL session open, preventing the next service start from opening the scanner for several minutes.

**Fix:**
```js
// index.js
const { sessions, removeSession } = require('./src/services/sessionManager');
const { jobs, cancelJob } = require('./src/services/autoScanJobManager');

async function gracefulShutdown(signal) {
  logger.info(`${signal} received — shutting down gracefully`);

  // Kill all active scan sessions (closes batch processes, cleans temp files)
  for (const [id] of sessions) removeSession(id, true);

  // Cancel all running auto-scan jobs
  for (const [id] of jobs) cancelJob(id);

  // Close Puppeteer browser singleton (after P-01 fix)
  const { closeBrowser } = require('./src/services/printService');
  if (closeBrowser) await closeBrowser();

  logger.info('Shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
```

---

### R-06 — Print Jobs Have No Status Endpoint — Silent Spooler Failures `[MEDIUM]`

**Impact:** `POST /api/print` returns `success: true` after handing the job to the OS spooler. If the printer is offline, jammed, or out of paper, the job disappears silently. No way to check status.

**Fix — Linux (CUPS):**
```js
// printService.js — parse lp output and expose job ID:
async function printPdf(pdfPath, printerName) {
  if (os.platform() === 'win32') { /* ... existing ... */ return; }

  const args = printerName ? ['-d', printerName] : [];
  const { stdout } = await exec(`lp ${args.join(' ')} "${pdfPath}"`);
  // stdout: "request id is HP_LaserJet-42 (1 file(s))"
  const match = stdout.match(/request id is (\S+)/);
  return match ? match[1] : null; // e.g. "HP_LaserJet-42"
}

// print.routes.js — store jobId → spoolerJobId mapping and poll:
const printJobs = new Map();

router.get('/print/:jobId', async (req, res) => {
  const job = printJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ success: false, message: 'Job not found' });
  // Poll lpstat -o <spoolerJobId>
  try {
    const { stdout } = await exec(`lpstat -o ${job.spoolerJobId} 2>/dev/null`);
    job.status = stdout.includes(job.spoolerJobId) ? 'printing' : 'completed';
  } catch { job.status = 'completed'; }
  res.json({ success: true, ...job });
});
```

---

### R-07 — Log Files Grow Without Bound — No Rotation `[LOW]`

**Fix:**
```bash
npm install winston-daily-rotate-file
```

```js
// logger.js
const DailyRotateFile = require('winston-daily-rotate-file');

// Replace the two File transports with:
new DailyRotateFile({
  filename: path.join(__dirname, '../../logs/error-%DATE%.log'),
  datePattern: 'YYYY-MM-DD',
  level: 'error',
  maxSize: '20m',
  maxFiles: '14d',
}),
new DailyRotateFile({
  filename: path.join(__dirname, '../../logs/combined-%DATE%.log'),
  datePattern: 'YYYY-MM-DD',
  maxSize: '20m',
  maxFiles: '14d',
}),
```

---

## 5. Code Quality Issues

### Things to Fix

| Issue | File | Fix |
|---|---|---|
| `SCAN_QUALITY=0` treated as `82` (falsy) | `scanService.js` | Change `\|\| 82` to `?? 82` |
| `pageCount` max 100 with no duration estimate | `scanAuto.routes.js` | Add `estimatedSeconds: pageCount * 15` to response |
| Windows scan path uses fragile `.replace(/\.png$/i, '.pdf')` | `scanService.js` | Use a fresh `uuidv4`-named temp path |
| `previewUrl` always points to `localhost` | `docs.routes.js` | Use `req.protocol + '://' + req.get('host')` |
| `/api/health` returns `ok` even when scanner/ImageMagick broken | `scan.routes.js` | Add dependency checks; return `degraded` status |
| No rate limiting | `app.js` | Add `express-rate-limit`: 10 print/min per IP |
| No max length on `examCode` / `uniqueId` | all route handlers | Validate max 100 chars |

### Things That Are Correct — Do Not Change

- Shell injection protection in `docs.routes.js` via `path.basename()` ✓
- `cleanupTimer.unref()` in session/job managers ✓
- `matchPinnedDevice` matching by model name (handles airscan index shifts) ✓
- Separate args array in `spawnBatchProcess` / `buildSaneArgs` ✓
- `handleScanError` with actionable error messages ✓

---

## 6. Cross-Platform Gaps

### Windows
- **ADF merged mode not supported** — Add `pdf-lib` (`npm install pdf-lib`) for pure-JS PDF merging, no native deps
- **NAPS2 not checked at startup** — Add check: `if (!fs.existsSync(NAPS2_PATH)) logger.warn('NAPS2 not found — Windows scanning will fail')`
- **No print job status polling** — Use `Get-PrintJob` via PowerShell for spooler status

### macOS
- **`imagesnap` check in `start.sh` is misleading** — The code never uses `imagesnap`. Remove the check
- **SANE on macOS requires extra setup** — Document: `brew install sane-backends && brew install sane-airscan`

---

## 7. Prioritized Action Plan

### Tier 1 — Before First Deployment (~1 day)

| Ref | Action | Effort |
|---|---|---|
| S-01 | Add `X-Api-Key` middleware to all `/api/*` routes | 2 hrs |
| S-02 | Replace `origin:'*'` with `ALLOWED_ORIGINS` allowlist | 30 min |
| P-01 | Keep one Puppeteer browser alive; open/close pages per job | 2 hrs |
| S-04 | Add `.env` to `.gitignore`; add `.env.example` | 15 min |
| R-05 | Add `SIGTERM`/`SIGINT` handlers; kill children; clean temp files | 1 hr |

### Tier 2 — Performance & Reliability Sprint (~3–4 days)

| Ref | Action | Effort |
|---|---|---|
| P-03 / R-01 | Implement `SANE_DEVICE_CACHE_MS` in `detectLinuxDeviceForced` | 1 hr |
| P-04 | Async mutex around scanner-open operations; `503` on conflict | 2 hrs |
| P-02 | Switch `waitUntil` to `networkidle2` or `domcontentloaded` | 1 hr |
| P-05 | Replace ImageMagick PDF steps with `img2pdf` | 3 hrs |
| R-01 | Implement `AIRSCAN_RETRY_DELAY_MS` sleep in retry path | 1 hr |
| R-04 | Make `detectImageMagick` synchronous (`execSync` at module load) | 30 min |
| R-06 | Parse `lp` job ID; expose `GET /api/print/:jobId` | 4 hrs |
| R-07 | Switch to `winston-daily-rotate-file`; 20 MB max, 14-day retention | 30 min |

### Tier 3 — Polish (~1–2 weeks)

- **S-03** — Inject CSP into rendered HTML; block `file://` requests in Puppeteer
- **R-02** — Check `child.exitCode` before silent timeout in `waitForBatchReady`
- **R-03** — Persist session state to disk; recover on restart
- **SSE** — Replace client polling with Server-Sent Events for real-time scan progress
- **Windows merge** — Add `pdf-lib` for Windows ADF merged-mode PDF output
- **Rate limiting** — `express-rate-limit`: 10 print/min, 5 scan sessions/min per IP
- **Enriched health** — Check `scanimage`, ImageMagick, `policy.xml`, printer count; return `degraded` status
- **Input validation** — Cap `examCode`/`uniqueId` at 100 characters

---

## 8. What Is Working Well ✅

> **Best design decision in the codebase:**
>
> The persistent `scanimage --batch` process for multi-page flatbed scanning is excellent. Keeping the SANE device open across pages and signaling each page via `stdin` write eliminates the airscan eSCL session conflict that breaks every naive spawn-per-page implementation. This bug is well-known in SANE/airscan communities and very non-obvious to solve. Implementing it correctly is a mark of genuine hardware-level understanding.

- **Background ADF job model** — POST start → background worker → GET poll is the correct design for long hardware operations
- **`handleScanError` error messages** — Mapping SANE error strings to human instructions including the exact `sed` fix for `policy.xml` is genuinely useful
- **File naming** — `examCode/uniqueId_examCode_p01of4_timestamp.pdf` is filesystem-safe and sorts correctly
- **`matchPinnedDevice`** — Correctly handles airscan index shifts by matching model name, not numeric index
- **`start.sh` / `start.bat`** — Port conflict detection, Node.js auto-install, scanner dependency check — unusually polished
- **`SCAN_QUALITY` env var** — Exposes JPEG compression quality with clear file-size vs. quality trade-off comments
- **`path.basename()` in `docs.routes.js`** — Correctly prevents directory traversal in file serving

---

## 9. Final Summary

This service does something genuinely hard: bridging a web application to physical printer and scanner hardware, cross-platform, driver-agnostic, in ~1,200 lines of well-structured Node.js. The architecture is sound. Several design decisions are non-obvious and correct.

**The two things to fix before any real deployment:**
1. Authentication (`S-01`) — one afternoon
2. Puppeteer singleton (`P-01`) — two hours

**The one thing that will hurt operators the most day-to-day:**
- `scanimage -L` running every session start (`P-03`) — configured but never implemented

| Summary | Count |
|---|---|
| Critical issues | 2 (auth + Puppeteer singleton) |
| High priority | 8 |
| Medium priority | 5 |
| Low / polish | 8 |
| Dead env vars | 2 (`SANE_DEVICE_CACHE_MS`, `AIRSCAN_RETRY_DELAY_MS`) |

**With Tier 1 fixes:** safe to deploy.  
**With Tier 2:** fast and robust enough for production exam-center use.  
**With Tier 3:** a polished, maintainable local service that runs reliably for years.

---

*End of Audit Report · Senior Engineering Review · August 2026*
