# Print Scanning — Local Service

Cross-platform **scanning** and **silent printing** backend.  
Runs on **Linux**, **Windows**, and **macOS**. Tested with Canon i-SENSYS MF3010.

**Port:** `4545` (fixed, never change)  
**Capabilities:** `scan`, `print`

---

## Quick Start

```bash
# Linux / macOS
bash start.sh

# Windows
start.bat
```

Open in your browser:

```
http://localhost:4545/            ← Full documentation UI (this page)
http://localhost:4545/api/health  ← Health check JSON
```

---

## Architecture

```
Admin Frontend (React)
    │
    ├── Scanning ──► GET  /api/scan       (single page)
    │                POST /api/scan/start  (multi-page session)
    │
    ├── Printing ──► POST /api/print      (silent print HTML/PDF)
    │                GET  /api/printers   (list available printers)
    │
    └── Health ────► GET  /api/health     (service status + capabilities)
    │
    ▼
Express Server — scaning-nodejs (port 4545)
    │
    ├─ Scanning Pipeline:
    │   OS Detection → Scanner Command → PNG → sharp + pdf-lib → PDF → scans/<examCode>/
    │
    └─ Printing Pipeline:
        HTML → Puppeteer (headless Chromium) → PDF → OS Print Spooler → Physical Printer
```

---

## System Prerequisites

### All Platforms

- **Node.js v18 LTS or higher** — https://nodejs.org

### Linux (Ubuntu / Debian)

```bash
sudo apt update
sudo apt install sane-utils cups -y
sudo systemctl enable --now cups
```

| Package | Used for |
|---------|----------|
| `sane-utils` | Scanner access via `scanimage` |
| `cups` | Print spooler — the `lp` command sends jobs to printers |

PNG → PDF conversion is handled in-process by the `sharp` and `pdf-lib` npm packages (installed via `npm install`, no OS package needed) — see [PDF Generation: Why No ImageMagick](#pdf-generation-why-no-imagemagick).

### Windows

1. Download **NAPS2** from https://www.naps2.com (for scanning)
2. Install with default settings → installs to `C:\Program Files\NAPS2\`
3. Connect your printer normally (USB or network) — no extra print setup needed

### macOS

```bash
brew install imagesnap
```

CUPS is pre-installed on macOS. Add your printer in **System Preferences > Printers & Scanners**.

> Grant Camera/Scanner permissions: System Preferences → Security & Privacy → Camera → allow Terminal.

---

## Installation

```bash
cd scaning_nodejs
npm install
```

> Puppeteer downloads its own Chromium binary automatically. No manual browser install needed.

---

## Running the Service

### Option 1 — Startup script (recommended)

```bash
# Linux / macOS
bash start.sh

# Windows — double-click OR from Command Prompt:
start.bat
```

### Option 2 — Manual

```bash
node index.js
```

### Option 3 — Development mode (auto-restart)

```bash
npm run dev
```

---

## Environment Variables

Create a `.env` file in the project root (same folder as `index.js`):

```env
# ═══════════════════════════════════════════════════════════════
#  SERVER
# ═══════════════════════════════════════════════════════════════

PORT=4545
LOG_LEVEL=info

# ═══════════════════════════════════════════════════════════════
#  SCANNING — Output
# ═══════════════════════════════════════════════════════════════

SCANS_DIR=./scans
SCAN_TIMEOUT_MS=60000
SCAN_SESSION_TIMEOUT_MS=1800000

# ═══════════════════════════════════════════════════════════════
#  SCANNING — Linux / SANE
# ═══════════════════════════════════════════════════════════════

SANE_DEVICE=pixma:04A92759_01E3B00006EC
SANE_MODE=Gray
SANE_SKIP_RESOLUTION=false

# ═══════════════════════════════════════════════════════════════
#  SCANNING — Windows / NAPS2
# ═══════════════════════════════════════════════════════════════

NAPS2_PATH=C:\Program Files\NAPS2\naps2.console.exe

# ═══════════════════════════════════════════════════════════════
#  PRINTING
# ═══════════════════════════════════════════════════════════════

# Default printer name. Leave empty to use system default.
# Find your printer name: GET /api/printers or run `lpstat -p`
PRINTER_NAME=

# Default duplex (double-sided) behavior for POST /api/print when the
# request doesn't specify `duplex` explicitly. Overridden automatically
# (with a warning, never a hard failure) if the printer doesn't support it —
# see GET /api/capabilities.
PRINT_DUPLEX_DEFAULT=false

# ═══════════════════════════════════════════════════════════════
#  DEVICE CAPABILITIES
# ═══════════════════════════════════════════════════════════════

# How long (ms) to cache the duplex/ADF capability checks (both run a shell
# command that doesn't need to be re-run on every print/scan call).
CAPABILITY_CACHE_MS=300000
```

### Variable Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `4545` | Service port — do not change |
| `LOG_LEVEL` | No | `info` | `error`, `warn`, `info`, `http`, `debug` |
| `SCANS_DIR` | No | `./scans` | Where scanned PDFs are saved |
| `SCAN_TIMEOUT_MS` | No | `60000` | Max wait for a single scan (ms) |
| `SCAN_SESSION_TIMEOUT_MS` | No | `1800000` | Multi-page session expiry (ms, default 30 min) |
| `ADF_PAGE_TIMEOUT_MS` | No | `15000` | Per-page timeout budget for `POST /api/scan/auto/start` (ADF batch scan job) |
| `SANE_DEVICE` | Recommended | auto-detect | Linux: pin a specific scanner device |
| `SANE_MODE` | No | `Gray` | Scan colour mode: `Gray`, `Color`, `Lineart` |
| `SANE_SKIP_RESOLUTION` | No | `false` | Set `true` if scanner rejects `--resolution` |
| `NAPS2_PATH` | No | default path | Windows: custom NAPS2 install location |
| `PRINTER_NAME` | No | system default | Default printer for print jobs |
| `PRINT_DUPLEX_DEFAULT` | No | `false` | Default for the `duplex` field on `POST /api/print` when omitted |
| `CAPABILITY_CACHE_MS` | No | `300000` | Cache duration (ms) for duplex/ADF capability checks |

---

# SCANNING

Everything related to document scanning — setup, API, troubleshooting.

---

## Scanner Setup

### How to find your scanner device (Linux)

```bash
# 1. List detected devices
scanimage -L

# 2. Example output:
# device `v4l:/dev/video0' is a Noname Integrated Camera     ← webcam, skip
# device `pixma:04A92759_01E3B00006EC' is a CANON MF3010     ← this one

# 3. Copy the device name into .env
# SANE_DEVICE=pixma:04A92759_01E3B00006EC
```

### How to find your scanner (Windows)

NAPS2 detects scanners automatically. For a specific scanner, create a NAPS2 profile:

1. Open NAPS2 GUI → **Profiles** → **Add** → select your scanner
2. Name it (e.g. `CanonMF3010`)
3. The service uses the default profile automatically

### How to find your scanner (macOS)

```bash
imagesnap -l
```

Set `SANE_DEVICE` only if you install SANE on macOS; otherwise imagesnap handles it.

---

## Scan API Reference

### Health Check

```
GET /api/health
```

```json
{
  "success": true,
  "status": "ok",
  "service": "Print Scanning Local Service",
  "platform": "linux",
  "port": 4545,
  "capabilities": ["scan", "print"]
}
```

---

### Single-Page Scan

```
GET /api/scan?examCode=MATH2026&uniqueId=ROLL123
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `examCode` | string | Yes | — | Exam identifier (folder + filename) |
| `uniqueId` | string | No | — | Roll number or center ID |
| `resolution` | number | No | `300` | DPI (72–1200) |

**Success:**

```json
{
  "success": true,
  "filename": "ROLL123_MATH2026_2026-04-01T07-38-46.pdf",
  "filePath": "/path/to/scans/MATH2026/ROLL123_MATH2026_2026-04-01T07-38-46.pdf",
  "platform": "linux",
  "device": "pixma:04A92759_01E3B00006EC",
  "message": "Document scanned and saved successfully"
}
```

---

### Multi-Page Scanning (Session-based)

For multi-page answer sheets. The flow:

```
POST /api/scan/start    → get sessionId
POST /api/scan/page/:id → scan each page (repeat N times)
POST /api/scan/complete/:id → merge all pages into one PDF
DELETE /api/scan/session/:id → cancel (optional)
```

#### Start Session

```
POST /api/scan/start
Content-Type: application/json
```

```json
{
  "examCode": "MATH2026",
  "pageCount": 4,
  "uniqueId": "ROLL123",
  "resolution": 300
}
```

**Response:**

```json
{
  "success": true,
  "sessionId": "a1b2c3d4e5f6",
  "totalPages": 4,
  "message": "Multi-page scan session started. Scan 4 page(s) one by one."
}
```

#### Scan a Page

```
POST /api/scan/page/:sessionId
```

**Response:**

```json
{
  "success": true,
  "currentPage": 2,
  "totalPages": 4,
  "remaining": 2,
  "message": "Page 2 scanned. Place the next page on the scanner."
}
```

#### Complete Session

```
POST /api/scan/complete/:sessionId
```

**Response:**

```json
{
  "success": true,
  "filename": "ROLL123_MATH2026_2026-04-09T10-30-00.pdf",
  "totalPages": 4,
  "message": "Multi-page scan complete. 4 page(s) merged."
}
```

#### Cancel Session

```
DELETE /api/scan/session/:sessionId
```

```json
{
  "success": true,
  "message": "Session cancelled. 2 temporary page(s) cleaned up."
}
```

#### Full Multi-Page Example (curl)

```bash
# 1. Start session
curl -X POST http://localhost:4545/api/scan/start \
  -H "Content-Type: application/json" \
  -d '{"examCode":"MATH2026","pageCount":2,"uniqueId":"ROLL123"}'

# 2. Scan page 1
curl -X POST http://localhost:4545/api/scan/page/SESSION_ID

# 3. Scan page 2
curl -X POST http://localhost:4545/api/scan/page/SESSION_ID

# 4. Merge
curl -X POST http://localhost:4545/api/scan/complete/SESSION_ID
```

---

### Automatic Multi-Page Scan (ADF)

For scanners with an automatic document feeder (ADF) — such as the Canon MAXIFY GX4070. Load every page into the feeder tray, start the job once with the page count, and the feeder pulls and scans each page back-to-back with no per-page prompt.

This is a **background job**, not a single blocking call — for a large `pageCount` (e.g. 50 pages), waiting on one HTTP request until every page finishes would leave the caller with no feedback for minutes. Instead: start the job, then poll its status to drive a live "N of M scanned" counter and, for `outputMode: "separate"`, watch each page's PDF appear as soon as it's converted (via `GET /api/docs/:examCode` — no waiting for the whole batch).

#### Start the job

```
POST /api/scan/auto/start
Content-Type: application/json
```

```json
{
  "examCode": "MATH2026",
  "uniqueId": "ROLL123",
  "pageCount": 50,
  "resolution": 300,
  "outputMode": "separate"
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `examCode` | string | Yes | — | Exam identifier (folder + filename) |
| `uniqueId` | string | No | — | Roll number or center ID |
| `pageCount` | number | Yes | — | Number of pages loaded in the feeder (1–100) |
| `resolution` | number | No | `300` | DPI (72–1200) |
| `outputMode` | string | No | `"separate"` | `"separate"` — one PDF per page, appears as each page finishes. `"merged"` — one PDF, only appears once the whole job completes. Not supported on Windows. |

On Linux/macOS, this endpoint checks the connected scanner's ADF support before starting a job (see [Device Capabilities](#device-capabilities)) and rejects up front with `400` if it finds none — rather than letting the SANE batch command fail partway through:

```json
{ "success": false, "message": "This scanner (\"airscan:e2:Canon GX4000 series\") has no ADF (feeder) — automatic multi-page scanning isn't available. Use POST /api/scan for single-page scans instead." }
```

If the capability check itself can't run (rather than running and confirming no ADF), the job is allowed to start anyway — a transient check failure never blocks a scan that might otherwise succeed.

**Response (returns immediately, before any page is scanned):**

```json
{ "success": true, "jobId": "a1b2c3d4e5f6", "totalPages": 50, "message": "Automatic scan started — scanning 50 page(s) from the feeder." }
```

#### Poll for progress

```
GET /api/scan/auto/:jobId
```

Poll this every 1–2 seconds while `status` is `"scanning"`.

```json
{
  "success": true,
  "jobId": "a1b2c3d4e5f6",
  "status": "scanning",
  "mode": "separate",
  "totalPages": 50,
  "scannedCount": 12,
  "files": [
    { "page": 1, "filename": "ROLL123_MATH2026_p01of50_2026-04-01T07-38-46.pdf", "filePath": "..." },
    { "page": 2, "filename": "ROLL123_MATH2026_p02of50_2026-04-01T07-38-46.pdf", "filePath": "..." }
  ],
  "warning": null,
  "error": null,
  "message": null
}
```

`status` is one of:

| Status | Meaning |
|--------|---------|
| `scanning` | In progress. `scannedCount` climbs as pages are pulled from the feeder. |
| `completed` | Done. `files` holds every page (separate mode) or the one merged file (merged mode). `warning` is set if fewer pages were scanned than requested (feeder ran out). |
| `failed` | No usable pages were produced. See `error`. |
| `cancelled` | Stopped via `DELETE`. Pages already converted (separate mode) stay on disk. |

#### Cancel a job

```
DELETE /api/scan/auto/:jobId
```

Kills the in-progress scanner process. For `outputMode: "separate"`, pages already converted to their own PDF before cancelling are kept. For `"merged"`, nothing is written until the very end, so cancelling loses the pages scanned so far.

```bash
# Start
curl -X POST http://localhost:4545/api/scan/auto/start \
  -H "Content-Type: application/json" \
  -d '{"examCode":"MATH2026","uniqueId":"ROLL123","pageCount":50,"outputMode":"separate"}'

# Poll (repeat until status is "completed"/"failed"/"cancelled")
curl http://localhost:4545/api/scan/auto/JOB_ID

# Cancel
curl -X DELETE http://localhost:4545/api/scan/auto/JOB_ID
```

A UI for this — enter exam code, unique ID, page count, pick separate/merged, and watch a live progress bar — is built into the **Scanned Documents Explorer** panel on the documentation page (`http://localhost:4545/`, Scanning tab).

---

### Scanned Documents API

#### List all exam folders

```
GET /api/docs
```

```json
{
  "success": true,
  "exams": [
    { "examCode": "MATH2026", "fileCount": 3 },
    { "examCode": "EXAM2027", "fileCount": 1 }
  ]
}
```

#### List documents for an exam

```
GET /api/docs/:examCode
```

```json
{
  "success": true,
  "examCode": "MATH2026",
  "documents": [
    {
      "filename": "ROLL123_MATH2026_2026-04-01T07-38-46.pdf",
      "size": 1843200,
      "createdAt": "2026-04-01T07:38:47.000Z",
      "previewUrl": "http://localhost:4545/api/docs/MATH2026/ROLL123_MATH2026_2026-04-01T07-38-46.pdf"
    }
  ]
}
```

#### Preview / download a document

```
GET /api/docs/:examCode/:filename
```

Returns PDF bytes with `Content-Type: application/pdf`.

---

### Scan Output Structure

```
scans/
  MATH2026/
    ROLL123_MATH2026_2026-04-01T07-38-46.pdf   ← with uniqueId
    MATH2026_2026-04-01T08-00-00.pdf           ← without uniqueId
  EXAM2027/
    EXAM2027_2026-04-02T08-10-00.pdf
```

---

## PDF Generation: Why No ImageMagick

Earlier versions of this service shelled out to ImageMagick (`convert`/`magick`) to turn scanned PNGs into PDFs. That approach was replaced with in-process Node libraries. Background, for anyone wondering why there's no `imagemagick` install step above:

**The problem.** ImageMagick ships with a `policy.xml` security policy that, on Ubuntu/Debian by default, blocks PDF read/write entirely (`rights="none" pattern="PDF"`). Every scan on a fresh install hit this and failed with a cryptic "not authorized" error — common enough that `handleScanError` in `scanService.js` had a dedicated branch just to explain the fix (editing `/etc/ImageMagick-6/policy.xml`). On top of that, spawning the `convert`/`magick` CLI per page added 2-4 seconds of process-launch and encode overhead — noticeable on a 10+ page scan.

**Why not `img2pdf` (Python)?** It solves the policy.xml problem (no ImageMagick involved) and is fast, but it's a Python CLI tool — this team doesn't use Python anywhere else, so adding a `pip install` step and a Python runtime dependency to a Node-only service wasn't worth it just to avoid a different CLI dependency.

**What it uses now.** Two npm packages, both installed via the normal `npm install` — no OS packages, no external CLI, no Python:

- [`sharp`](https://sharp.pixelplumbing.com/) — recompresses each scanned PNG to JPEG at the same quality ImageMagick used to apply (`SCAN_QUALITY`, default `82`). Ships prebuilt native binaries for Linux/macOS/Windows, so there's nothing to compile.
- [`pdf-lib`](https://pdf-lib.js.org/) — pure JavaScript, embeds each JPEG page into a PDF document and writes it to disk.

Both run in-process (no subprocess spawn), so there's no policy.xml to hit and no per-page CLI startup cost. Output contract is unchanged — same `SCAN_QUALITY`-controlled JPEG compression, same PDF landing at the same path — so nothing downstream (routes, job manager, frontend) needed to change.

See `docs/pdf-generation-migration.html` for the full file-by-file breakdown of this change.

---

### Scan Troubleshooting

#### "Scanner not found"

```bash
scanimage -L                           # Check detection
sudo apt install libsane-extras -y     # Extra SANE backends
sudo usermod -aG scanner $USER         # Fix permissions (re-login after)
```

#### "sane_start: Invalid argument"

1. No paper on flatbed — place document and retry
2. Scanner warming up — wait 10–15 seconds
3. Wrong mode — check `scanimage --help -d <device>` and update `SANE_MODE`

#### "unrecognized option '--resolution'"

```env
SANE_SKIP_RESOLUTION=true
```

#### Scan times out

```env
SCAN_TIMEOUT_MS=120000
```

#### "Session expired"

Sessions live in memory and expire after 30 minutes by default:

```env
SCAN_SESSION_TIMEOUT_MS=3600000
```

---

### Supported Scanners

| Scanner | OS | Backend | Status |
|---------|-----|---------|--------|
| Canon i-SENSYS MF3010 | Linux | SANE pixma | Tested |
| Canon CanoScan series | Linux | SANE pixma/plustek | Compatible |
| Epson scanners | Linux | SANE epson2 | Compatible |
| HP scanners (USB/network) | Linux | SANE hpaio | Compatible |
| Any TWAIN/WIA scanner | Windows | NAPS2 | Compatible |
| Any macOS scanner | macOS | imagesnap | Compatible |

Full SANE list: http://www.sane-project.org/sane-supported-devices.html

---

# PRINTING

Everything related to silent printing — setup, API, troubleshooting.

---

## How Printing Works

```
Frontend sends HTML → POST /api/print
                          │
                          ▼
              Puppeteer (headless Chromium)
              renders HTML → generates PDF
                          │
                          ▼
              OS Print Spooler sends PDF to printer
                Linux/macOS: lp (CUPS)
                Windows: pdf-to-printer
                          │
                          ▼
              Physical printer outputs the page
```

The entire process is **silent** — no browser dialog, no user interaction required.

---

## Printer Setup

### Linux (Ubuntu / Debian)

CUPS (Common Unix Printing System) handles all print jobs on Linux.

```bash
# 1. Install CUPS
sudo apt install cups -y

# 2. Start and enable CUPS
sudo systemctl enable --now cups

# 3. Add your user to the lpadmin group (for admin access)
sudo usermod -aG lpadmin $USER
# Log out and back in after this

# 4. Open CUPS web interface to add/manage printers
#    http://localhost:631

# 5. Verify your printer is detected
lpstat -p -d

# 6. Test a print
echo "Hello from Print Scanning" | lp
```

#### Adding a printer via CUPS web UI

1. Open http://localhost:631 in your browser
2. Click **Administration** → **Add Printer**
3. Select your printer (USB or network discovered)
4. Follow the wizard — select the correct driver
5. Set it as default if desired

#### Adding a network printer (command line)

```bash
# HP network printer
lpadmin -p HP-LaserJet -E -v socket://192.168.1.50:9100 -m everywhere

# Set as default
lpoptions -d HP-LaserJet

# Verify
lpstat -p -d
```

#### Common CUPS commands

| Command | Description |
|---------|-------------|
| `lpstat -p -d` | List printers and show default |
| `lpstat -t` | Full printer status |
| `lp filename.pdf` | Print to default printer |
| `lp -d PrinterName filename.pdf` | Print to specific printer |
| `lpq` | Show print queue |
| `cancel -a` | Cancel all print jobs |
| `cupsctl --remote-admin` | Enable remote CUPS admin |
| `sudo systemctl restart cups` | Restart CUPS |

### Windows

No extra setup needed. The service uses `pdf-to-printer` which talks directly to the Windows print spooler.

1. Connect your printer (USB or network)
2. Ensure it appears in **Settings > Printers & Scanners**
3. That's it — the service detects it automatically

#### Verify from command line

```powershell
# List printers
Get-Printer | Format-Table Name, DriverName, PortName

# Print a test page
Start-Process -FilePath "rundll32.exe" -ArgumentList "printui.dll,PrintUIEntry /k /n `"Your Printer Name`""
```

### macOS

CUPS is pre-installed on macOS.

1. Add your printer in **System Preferences > Printers & Scanners**
2. Click the **+** button to add a new printer
3. Select your printer from the list
4. Verify:

```bash
lpstat -p -d
```

#### Test print from terminal

```bash
echo "Hello from Print Scanning" | lp
```

---

## Setting a Default Printer for the Service

You can set a default printer in two ways:

**Option 1 — Environment variable (persistent)**

```env
# In .env file
PRINTER_NAME=Canon-MF3010
```

**Option 2 — Per-request (override)**

```json
{
  "html": "<h1>Hello</h1>",
  "printerName": "HP-LaserJet-Pro"
}
```

The priority order is: `printerName` in request body → `PRINTER_NAME` env → system default.

---

## Device Capabilities

Reports whether the currently-connected printer and scanner actually support duplex (double-sided) printing and ADF (automatic feeder) bulk scanning — Linux/macOS only, via `lpoptions -p <printer> -l` and `scanimage --help -d <device>`. Windows has no equivalent driver-introspection, so its values are always `null` ("unknown", not "unsupported").

This same check runs automatically once at service startup (logged as a warning if either is missing) and gates `POST /api/scan/auto/start` — see [Automatic Multi-Page Scan (ADF)](#automatic-multi-page-scan-adf). It's also surfaced live on the documentation page (`http://localhost:4545/`, **Device Capabilities** panel) so you can check a printer/scanner swap without shell access to the exam-center machine.

```
GET /api/capabilities
```

**Response:**

```json
{
  "success": true,
  "printer": {
    "name": "Canon_GX4000_series_USB",
    "duplexSupported": true,
    "sidesOptions": ["one-sided", "two-sided-long-edge", "two-sided-short-edge"]
  },
  "scanner": {
    "device": "airscan:e2:Canon GX4000 series",
    "adfSupported": true,
    "sources": ["Flatbed", "ADF"]
  }
}
```

| Field | Meaning |
|-------|---------|
| `printer.duplexSupported` | `true`/`false` — checked via the printer's CUPS driver. `null` on Windows (unchecked). |
| `printer.sidesOptions` | Raw `sides` values the CUPS driver reports (empty if unsupported/unchecked). |
| `scanner.adfSupported` | `true`/`false` — checked via `scanimage --help`. `null` on Windows, or if the check itself couldn't complete (e.g. the scanner is mid-session — see the ADF gating note above). |
| `scanner.sources` | Raw `--source` values the SANE backend reports. |

Results are cached for `CAPABILITY_CACHE_MS` (default 5 minutes) since both underlying commands can be slow on a network scanner.

```bash
curl http://localhost:4545/api/capabilities
```

---

## Print API Reference

### List Available Printers

```
GET /api/printers
```

**Response:**

```json
{
  "success": true,
  "printers": ["Canon-MF3010", "HP-LaserJet-Pro", "PDF-Printer"],
  "default": "Canon-MF3010"
}
```

Use the printer name values in the `printerName` field when calling `/api/print`.

---

### Silent Print

```
POST /api/print
Content-Type: application/json
```

**Request body:**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `html` | string | Yes* | — | Full HTML document to render and print |
| `base64Pdf` | string | No | — | Pre-rendered PDF as base64 (skip Puppeteer) |
| `printerName` | string | No | env/system default | Target printer from `/api/printers` |
| `printType` | string | No | `"exam"` | `"exam"` or `"omr"` |
| `duplex` | boolean | No | `PRINT_DUPLEX_DEFAULT` | `true` = double-sided (long-edge flip), `false` = single-sided |

*Either `html` or `base64Pdf` must be provided.

**Duplex printing:** requires a printer whose CUPS driver actually exposes a duplex ("sides") option — check [Device Capabilities](#device-capabilities) first. If `duplex: true` is requested but the printer doesn't support it, the job is **automatically printed single-sided instead** (never fails or drops pages) and the response includes a `warning` field explaining the downgrade.

**Print types:**

| Type | Margins | Scale | Use case |
|------|---------|-------|----------|
| `exam` | 0.25in all sides | 1.0 | Exam papers, multi-page documents |
| `omr` | 0 (none) | 0.95 | OMR answer sheets, precise layout |

**Example — print an exam:**

```bash
curl -X POST http://localhost:4545/api/print \
  -H "Content-Type: application/json" \
  -d '{"html":"<h1>Test Exam</h1><p>Sample content.</p>","printType":"exam"}'
```

**Example — print to a specific printer:**

```bash
curl -X POST http://localhost:4545/api/print \
  -H "Content-Type: application/json" \
  -d '{"html":"<h1>Test</h1>","printerName":"HP-LaserJet-Pro","printType":"exam"}'
```

**Example — print OMR sheet:**

```bash
curl -X POST http://localhost:4545/api/print \
  -H "Content-Type: application/json" \
  -d '{"html":"<div>OMR Sheet Content</div>","printType":"omr"}'
```

**Example — print double-sided:**

```bash
curl -X POST http://localhost:4545/api/print \
  -H "Content-Type: application/json" \
  -d '{"html":"<h1>Test Exam</h1>","printType":"exam","duplex":true}'
```

**Success response:**

```json
{
  "success": true,
  "message": "Print job queued successfully",
  "jobId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
}
```

**Success response, duplex requested but downgraded to single-sided:**

```json
{
  "success": true,
  "message": "Print job queued successfully",
  "jobId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "warning": "Printer \"Canon_GX4000_series_USB\" doesn't support duplex — printed single-sided instead."
}
```

**Error response:**

```json
{
  "success": false,
  "message": "lp: No default destination",
  "jobId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
}
```

---

## Print Troubleshooting

### "lp: No default destination" (Linux / macOS)

No default printer is configured. Fix:

```bash
# List available printers
lpstat -p

# Set one as default
lpoptions -d YourPrinterName

# Or set in .env
PRINTER_NAME=YourPrinterName
```

### "No printers detected"

**Linux:**
```bash
# Is CUPS running?
sudo systemctl status cups

# Restart CUPS
sudo systemctl restart cups

# Check USB printer connection
lsusb | grep -i printer
```

**Windows:**
- Open **Settings > Printers & Scanners** and check if the printer is listed
- Try removing and re-adding the printer

**macOS:**
- Open **System Preferences > Printers & Scanners**
- Click the **+** button if no printers are shown

### Print job hangs / nothing comes out

```bash
# Check CUPS queue for stuck jobs (Linux/macOS)
lpq

# Cancel all stuck jobs
cancel -a

# Restart CUPS
sudo systemctl restart cups

# Check printer status
lpstat -t
```

### PDF renders incorrectly (wrong margins, cut off)

- Check you're using the correct `printType` (`exam` vs `omr`)
- `omr` uses zero margins and 0.95 scale — designed for precise bubble sheets
- `exam` uses 0.25in margins — standard for text documents
- Verify your HTML uses absolute units (pt, in, cm) rather than relative (%, vh, vw)

### Puppeteer / Chromium issues

```bash
# If Chromium didn't download during npm install
npx puppeteer install chrome

# Linux: install missing shared libraries
sudo apt install -y libgbm1 libnss3 libatk-bridge2.0-0 libx11-xcb1
```

### "pdf-to-printer is not a function" (Windows)

```bash
# Reinstall the package
npm uninstall pdf-to-printer
npm install pdf-to-printer
```

---

## Dependencies for Printing

| Package | Purpose | Platform |
|---------|---------|----------|
| `puppeteer` | Headless Chromium — converts HTML to PDF | All |
| `pdf-to-printer` | Sends PDF to Windows print spooler | Windows |
| CUPS (`lp` command) | Sends PDF to printer | Linux, macOS |

Puppeteer downloads its own Chromium on `npm install` (~300 MB). On subsequent installs it reuses the cached binary.

---

# COMMON

Shared information across scanning and printing.

---

## Admin Frontend Integration

The admin frontend (`admin-frontend`) uses a **feature flag** to switch between QZ Tray and this local service:

```env
# In admin-frontend/.env.local
REACT_APP_USE_QZ_TRAY=false          # false = use local service, true = use QZ Tray
REACT_APP_PRINT_SERVICE_URL=http://localhost:4545
```

The adapter pattern (`print-adapter.js`) dynamically loads either `qz-setup.js` or `local-print-service.js` based on this flag. No code changes needed to switch — just flip the env var and restart the React dev server.

---

## Service Not Reachable (`Failed to fetch`)

```bash
# 1. Check if service is running
curl http://localhost:4545/api/health

# 2. Check port is not blocked
sudo ufw allow 4545        # Linux
# Or check Windows Firewall

# 3. Confirm React is using http (not https)
# REACT_APP_PRINT_SERVICE_URL=http://localhost:4545
```

---

## Logs

```
logs/combined.log   — all levels (info, warn, error, http)
logs/error.log      — errors only
```

Console output is colour-coded. Set `LOG_LEVEL=debug` for verbose output.

---

## Project Structure

```
scaning-nodejs/
├── index.js                  Entry point — starts Express on port 4545
├── package.json              Dependencies
├── start.bat                 Windows startup script
├── start.sh                  Linux/macOS startup script
├── .env                      Environment variables
├── README.md                 This documentation
├── scans/                    Scanned PDF output (auto-created)
├── logs/                     Winston log files (auto-created)
│   ├── combined.log
│   └── error.log
└── src/
    ├── app.js                Express app (CORS, Morgan, route mounting)
    │
    ├── routes/
    │   ├── scan.routes.js           GET  /api/health, GET /api/scan
    │   ├── scanSession.routes.js    POST /api/scan/start, /page, /complete
    │   ├── scanAuto.routes.js       POST /api/scan/auto/start, GET|DELETE /api/scan/auto/:jobId
    │   ├── print.routes.js          POST /api/print, GET /api/printers
    │   ├── docs.routes.js           GET  /api/docs, /api/docs/:exam/:file
    │   └── documentation.routes.js  GET  / and /documentation (this UI)
    │
    ├── services/
    │   ├── scanService.js           OS detect, scanner command, PNG→PDF
    │   ├── sessionManager.js        Multi-page scan session store
    │   ├── autoScanJobManager.js    Background ADF job store (progress polling)
    │   ├── printService.js          HTML→PDF (Puppeteer) + silent print
    │   └── printerService.js        Printer enumeration (CUPS/pdf-to-printer)
    │
    ├── templates/
    │   └── doc.html                 Documentation page template
    │
    └── utils/
        ├── logger.js                Winston logger
        └── fileHandler.js           Output path builder + file validator
```

---

## API Documentation (Swagger)

Every endpoint in this service is documented as an OpenAPI 3.0 spec, generated from JSDoc comments (`swagger-jsdoc`) and served interactively via `swagger-ui-express` — modeled on how this monorepo's NestJS services document their APIs with `@nestjs/swagger` (`DocumentBuilder` + `@ApiTags`/`@ApiOperation`/`@ApiResponse`), translated to plain Express since there are no decorators/classes here.

```
http://localhost:4545/api-docs        ← interactive Swagger UI
http://localhost:4545/api-docs-json   ← raw OpenAPI 3.0 JSON spec
```

Endpoints are grouped into the same tags used throughout this README: **Health**, **Scanning**, **Scan Sessions**, **Auto Scan (ADF)**, **Documents**, **Printing**, **Capabilities**. An **Export JSON** button in the Swagger UI topbar downloads the spec directly (fetches `/api-docs-json`).

**Enabling/disabling:** controlled by `SWAGGER_ENABLED` in `.env` (`true`/`false`). If unset, Swagger is enabled whenever `NODE_ENV !== "production"` — since this service never sets `NODE_ENV`, it's on by default. Disable it with:

```env
SWAGGER_ENABLED=false
```

There is no authentication on these docs or the underlying API — this service is intended for local network use only, on the exam-center machine attached to the physical scanner/printer.

---

## API Routes Summary

### Scanning Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/health` | Service status + capabilities |
| `GET` | `/api/scan` | Single-page scan |
| `POST` | `/api/scan/start` | Start multi-page session |
| `POST` | `/api/scan/page/:id` | Scan one page in session |
| `POST` | `/api/scan/complete/:id` | Merge pages into PDF |
| `DELETE` | `/api/scan/session/:id` | Cancel session |
| `POST` | `/api/scan/auto/start` | Start an automatic ADF multi-page scan job (background, returns immediately) |
| `GET` | `/api/scan/auto/:jobId` | Poll job progress — scannedCount, files as they land, final status |
| `DELETE` | `/api/scan/auto/:jobId` | Cancel a running automatic scan job |
| `GET` | `/api/docs` | List exam folders |
| `GET` | `/api/docs/:exam` | List documents for exam |
| `GET` | `/api/docs/:exam/:file` | Download/preview PDF |

### Printing Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/printers` | List available printers + default |
| `POST` | `/api/print` | Silent print HTML content (supports `duplex`) |

### Device Capabilities Endpoint

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/capabilities` | Duplex printing + ADF scanning support for the currently-connected devices |

### Documentation Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/` | Documentation UI |
| `GET` | `/documentation` | Documentation UI (alias) |
| `GET` | `/api-docs` | Swagger UI (interactive OpenAPI docs, if `SWAGGER_ENABLED`) |
| `GET` | `/api-docs-json` | Raw OpenAPI 3.0 JSON spec |
