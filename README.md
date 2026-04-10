# Print Scanning — Scanning Service

Cross-platform document scanning backend for Print Scanning. Supports Windows, Linux, and macOS. Tested and verified with Canon i-SENSYS MF3010.

**Port:** `4545` (fixed, never change)

---

## Quick Start

```bash
# Linux / macOS
bash start.sh

# Windows
start.bat
```

Then open in your browser:

```
http://localhost:4545/doc          ← Full documentation UI
http://localhost:4545/api/health   ← Health check JSON
```

---

## Architecture

```
React (Admin Frontend / ScanOMRSheets.js)
    |
    | Single page:  GET /api/scan?rollNumber=ROLL123&examCode=MATH2026
    | Multi-page:   POST /api/scan/start  →  POST /api/scan/page/:id (×N)  →  POST /api/scan/complete/:id
    v
Express Server — scaning_nodejs (port 4545)
    |
    | 1. Detect OS (process.platform)
    | 2. Linux: auto-detect scanner device (scanimage -L → skip webcam → pick pixma/canon)
    v
OS Scanner Command
  Windows  →  naps2.console.exe -o "output.pdf" --noprofile
  Linux    →  scanimage --device-name="..." --mode=Gray --resolution=300 --format=png -o /tmp/scan.png
               && (convert scan.png output.pdf || magick scan.png output.pdf)
               && rm -f scan.png
  macOS    →  scanimage (same as Linux) + ImageMagick
    |
    v
Multi-page:  each page → temp PNG in /tmp  →  convert page1.png page2.png ... → output.pdf
Single-page: scan → temp PNG → output.pdf  (same as before)
    |
    v
PDF saved to:  scans/<examCode>/<rollNumber>_<examCode>_<YYYY-MM-DDTHH-MM-SS>.pdf
    |
    v
JSON response → { success, filename, filePath, device, platform }
```

---

## System Prerequisites

### All platforms

- **Node.js v18 LTS or higher** — https://nodejs.org

### Linux (Ubuntu / Debian)

```bash
sudo apt update
sudo apt install sane-utils imagemagick -y
```

| Tool | Package | Used for |
|------|---------|----------|
| `scanimage` | `sane-utils` | Controls scanner via SANE |
| `convert` | `imagemagick` | PNG → PDF (ImageMagick ≤6) |
| `magick` | `imagemagick` | PNG → PDF (ImageMagick ≥7, auto-fallback) |

### Windows

1. Download **NAPS2** from https://www.naps2.com
2. Install with default settings → installs to `C:\Program Files\NAPS2\`
3. Service calls `naps2.console.exe` automatically

### macOS

```bash
# Install Homebrew first if not present
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

brew install imagesnap imagemagick
```

> Grant Camera/Scanner permissions: System Preferences → Security & Privacy → Camera → allow Terminal.

---

## Installation

```bash
cd scaning_nodejs
npm install
```

---

## Running the Service

### Option 1 — Startup script (recommended)

```bash
# Linux / macOS
bash start.sh

# Windows — double-click OR from Command Prompt:
start.bat
```

The startup scripts check for Node.js, check for scanner tools, install npm deps if missing, then start the server.

### Option 2 — Manual

```bash
node index.js
```

### Option 3 — Development mode (auto-restart on file save)

```bash
npm run dev
```

---

## Environment Variables

Create a `.env` file inside `scaning_nodejs/` (same folder as `index.js`):

```env
# ─────────────────────────────────────────────────────────────────
# SERVER
# ─────────────────────────────────────────────────────────────────

# Port the service listens on. Always 4545 — do not change.
PORT=4545

# Log level: error | warn | info | http | debug
# Default: info
LOG_LEVEL=info

# ─────────────────────────────────────────────────────────────────
# OUTPUT
# ─────────────────────────────────────────────────────────────────

# Where scanned PDFs are saved.
# Default: ./scans  (inside this project folder)
# Use absolute path to save elsewhere:
#   SCANS_DIR=/home/user/Documents/ExamScans
#   SCANS_DIR=C:\ExamScans              (Windows)
SCANS_DIR=./scans

# ─────────────────────────────────────────────────────────────────
# SCAN BEHAVIOUR
# ─────────────────────────────────────────────────────────────────

# Max time in milliseconds to wait for scanner command (per page).
# Default: 60000 (60 seconds)
# Increase for slow network scanners: 120000
SCAN_TIMEOUT_MS=60000

# How long a multi-page scan session stays alive before auto-expiring (ms).
# Default: 1800000 (30 minutes)
# Sessions that exceed this are purged and their temp files cleaned up.
SCAN_SESSION_TIMEOUT_MS=1800000

# ─────────────────────────────────────────────────────────────────
# LINUX / SANE ONLY
# ─────────────────────────────────────────────────────────────────

# Pin a specific SANE device name.
# If not set, the service auto-detects: picks first pixma/canon device,
# then first non-webcam device, then falls back to SANE default.
#
# How to find your device name:
#   scanimage -L
#
# Examples:
#   SANE_DEVICE=pixma:04A92759_01E3B00006EC     ← Canon MF3010
#   SANE_DEVICE=epson2:libusb:001:005           ← Epson
#   SANE_DEVICE=hpaio:/net/HP_LaserJet?ip=192.168.1.50  ← HP network
SANE_DEVICE=pixma:04A92759_01E3B00006EC

# Scan colour mode passed to scanimage.
# Default: Gray  (faster, smaller file — best for exam documents)
# Options: Gray | Color | Lineart
# Check your scanner's supported modes: scanimage --help -d <device>
SANE_MODE=Gray

# Set to "true" ONLY if your scanner backend does NOT support --resolution.
# Default: false (--resolution=300 is passed)
#
# Canon MF3010 pixma backend DOES support --resolution — leave this false.
# If you see "scanimage: unrecognized option '--resolution=...'" with a
# different scanner, set this to true.
SANE_SKIP_RESOLUTION=false

# ─────────────────────────────────────────────────────────────────
# WINDOWS ONLY
# ─────────────────────────────────────────────────────────────────

# Full path to NAPS2 CLI executable.
# Only set this if NAPS2 is installed in a non-default location.
# Default: C:\Program Files\NAPS2\naps2.console.exe
NAPS2_PATH=C:\Program Files\NAPS2\naps2.console.exe
```

### Which variables do you actually need to set?

| Variable | Must set? | When |
|----------|-----------|------|
| `PORT` | No | Only if 4545 is already in use |
| `LOG_LEVEL` | No | Set `debug` for verbose troubleshooting |
| `SCANS_DIR` | No | Change only if you want PDFs saved elsewhere |
| `SCAN_TIMEOUT_MS` | No | Increase if scanner is slow or on network |
| `SCAN_SESSION_TIMEOUT_MS` | No | Increase if multi-page sessions expire too quickly (default 30 min) |
| `SANE_DEVICE` | **Recommended** | When more than one scanner/webcam is connected |
| `SANE_MODE` | No | Set `Color` for colour exam documents |
| `SANE_SKIP_RESOLUTION` | No | Set `true` only if you get "unrecognized option --resolution" |
| `NAPS2_PATH` | No | Windows only — custom NAPS2 install path |

### How to get `SANE_DEVICE` (Linux / macOS / Windows)

`SANE_DEVICE` is only used on systems that run SANE (mainly Linux, and macOS if SANE is installed).  
On Windows, this variable is not used because scanning goes through NAPS2.

#### Linux (recommended flow)

```bash
# 1) List detected devices
scanimage -L

# 2) Example output:
# device `pixma:04A92759_01E3B00006EC' is a CANON Canon i-SENSYS MF3010

# 3) Use the value between backticks in .env
# SANE_DEVICE=pixma:04A92759_01E3B00006EC
```

#### macOS

By default this project uses `imagesnap` on macOS, so `SANE_DEVICE` is usually not required.

- If you stay with `imagesnap`, list devices using:

```bash
imagesnap -l
```

- If you install SANE on macOS and want to use SANE-style devices, then:

```bash
scanimage -L
```

and set:

```env
SANE_DEVICE=<value_from_scanimage_-L>
```

#### Windows

`SANE_DEVICE` is **not applicable** on Windows.

Use NAPS2 instead:

1. Install NAPS2.
2. Set optional path:

```env
NAPS2_PATH=C:\Program Files\NAPS2\naps2.console.exe
```

3. If you need a specific scanner, create a NAPS2 profile and use `--profile` in command logic.

---

## API Reference

### Health check

```
GET http://localhost:4545/api/health
```

```json
{
  "success": true,
  "status": "ok",
  "service": "Print Scanning Service",
  "platform": "linux",
  "port": 4545,
  "timestamp": "2026-04-01T07:38:43.000Z"
}
```

---

### Trigger a scan

```
GET http://localhost:4545/api/scan?rollNumber=ROLL123&examCode=MATH2026
```

**Query parameters:**

| Parameter | Type | Required | Default | Notes |
|-----------|------|----------|---------|-------|
| `rollNumber` | string | Yes | — | Used in PDF filename |
| `examCode` | string | Yes | — | Used in PDF filename |
| `resolution` | number | No | `300` | DPI — 72 to 1200 |

**Success response:**

```json
{
  "success": true,
  "filename": "ROLL123_MATH2026_2026-04-01T07-38-46.pdf",
  "filePath": "/path/to/scaning_nodejs/scans/MATH2026/ROLL123_MATH2026_2026-04-01T07-38-46.pdf",
  "platform": "linux",
  "device": "pixma:04A92759_01E3B00006EC",
  "scansDirectory": "/path/to/scaning_nodejs/scans",
  "message": "Document scanned and saved successfully"
}
```

> Tip: copy the `device` value from the response directly into `SANE_DEVICE` in `.env` to pin it permanently.

**Error response:**

```json
{
  "success": false,
  "message": "Scanner rejected the scan request (sane_start: Invalid argument). Most common causes: (1) no paper on the flatbed..."
}
```

---

### Multi-Page Scanning (Session-based)

When a student's answer sheet has multiple pages (e.g., front and back of a paper = 2 pages), use the multi-page session flow to scan all pages one by one and merge them into a single PDF.

**How it works:**

1. Start a session specifying the roll number, exam code, and total page count.
2. For each page, place it on the flatbed and call the "scan page" endpoint.
3. After all pages are scanned, call "complete" to merge them into one PDF.
4. If you need to abort, call "cancel" to clean up temp files.

The single-page `GET /api/scan` endpoint is unchanged and fully backward compatible. Use the session endpoints only when `pageCount > 1`.

**Architecture:**

```
Admin Frontend                    Scanning Service (port 4545)
     |                                    |
     |  POST /api/scan/start              |
     |  { rollNumber, examCode,           |
     |    pageCount: 4 }                  |
     |─────────────────────────────────►  |  Creates session, returns sessionId
     |  ◄──────── { sessionId }           |
     |                                    |
     |  [User places page 1 on scanner]   |
     |  POST /api/scan/page/:sessionId    |
     |─────────────────────────────────►  |  scanimage → temp PNG #1
     |  ◄──── { currentPage: 1,           |
     |          remaining: 3 }            |
     |                                    |
     |  ... repeat for pages 2, 3, 4 ...  |
     |                                    |
     |  POST /api/scan/complete/:id       |
     |─────────────────────────────────►  |  convert page1.png page2.png ... → output.pdf
     |  ◄──── { filename, filePath }      |  Cleans up temp PNGs
```

---

#### Start a multi-page scan session

```
POST http://localhost:4545/api/scan/start
Content-Type: application/json
```

**Request body:**

```json
{
  "rollNumber": "ROLL123",
  "examCode": "MATH2026",
  "pageCount": 4,
  "resolution": 300
}
```

| Field | Type | Required | Default | Notes |
|-------|------|----------|---------|-------|
| `rollNumber` | string | Yes | — | Used in final PDF filename |
| `examCode` | string | Yes | — | Used in final PDF filename and folder |
| `pageCount` | number | Yes | — | Total number of pages to scan (1–100) |
| `resolution` | number | No | `300` | DPI — 72 to 1200 |

**Success response:**

```json
{
  "success": true,
  "sessionId": "a1b2c3d4e5f6a1b2c3d4e5f6",
  "totalPages": 4,
  "message": "Multi-page scan session started. Scan 4 page(s) one by one."
}
```

---

#### Scan a page in the session

Place the next page face-down on the flatbed, then call:

```
POST http://localhost:4545/api/scan/page/:sessionId
```

No request body needed. The service scans the page and stores the image as a temporary PNG.

**Success response:**

```json
{
  "success": true,
  "sessionId": "a1b2c3d4e5f6a1b2c3d4e5f6",
  "currentPage": 2,
  "totalPages": 4,
  "remaining": 2,
  "message": "Page 2 scanned. Place the next page on the scanner and scan again."
}
```

When `remaining` is `0`, all pages are done — call the complete endpoint.

**Error response (e.g., all pages already scanned):**

```json
{
  "success": false,
  "message": "All 4 pages have already been scanned. Call POST /api/scan/complete/<sessionId> to finalize."
}
```

---

#### Complete the session (merge into PDF)

After all pages are scanned, finalize the session to merge all pages into a single PDF:

```
POST http://localhost:4545/api/scan/complete/:sessionId
```

The response has the same shape as the single-page `GET /api/scan` endpoint:

**Success response:**

```json
{
  "success": true,
  "filename": "ROLL123_MATH2026_2026-04-09T10-30-00.pdf",
  "filePath": "/path/to/scans/MATH2026/ROLL123_MATH2026_2026-04-09T10-30-00.pdf",
  "platform": "linux",
  "device": "pixma:04A92759_01E3B00006EC",
  "scansDirectory": "/path/to/scans",
  "totalPages": 4,
  "message": "Multi-page scan complete. 4 page(s) merged into ROLL123_MATH2026_2026-04-09T10-30-00.pdf"
}
```

**Error response (not all pages scanned):**

```json
{
  "success": false,
  "message": "Only 2 of 4 pages scanned. Scan the remaining pages or cancel the session."
}
```

---

#### Cancel a session

If you need to abort a multi-page scan (e.g., wrong roll number, scanner jam), cancel the session to clean up temporary files:

```
DELETE http://localhost:4545/api/scan/session/:sessionId
```

**Success response:**

```json
{
  "success": true,
  "message": "Session cancelled. 2 temporary page(s) cleaned up."
}
```

---

#### Example: Full multi-page scan with curl

```bash
# 1. Start a 2-page session (front + back of one paper)
curl -X POST http://localhost:4545/api/scan/start \
  -H "Content-Type: application/json" \
  -d '{"rollNumber":"ROLL123","examCode":"MATH2026","pageCount":2}'
# → { "sessionId": "abc123...", "totalPages": 2 }

# 2. Place page 1 (front) on scanner, then scan
curl -X POST http://localhost:4545/api/scan/page/abc123...
# → { "currentPage": 1, "remaining": 1 }

# 3. Place page 2 (back) on scanner, then scan
curl -X POST http://localhost:4545/api/scan/page/abc123...
# → { "currentPage": 2, "remaining": 0 }

# 4. Merge into a single PDF
curl -X POST http://localhost:4545/api/scan/complete/abc123...
# → { "filename": "ROLL123_MATH2026_2026-04-09T10-30-00.pdf", ... }
```

> **Note:** The admin frontend automates this entire flow. When the user sets "Pages" > 1 and clicks "Scan", the UI walks them through each page with a progress bar and prompts.

---

### List all exam folders

Returns every exam code that has at least one scanned document.

```
GET http://localhost:4545/api/docs
```

**Success response:**

```json
{
  "success": true,
  "exams": [
    { "examCode": "MATH2026", "fileCount": 3 },
    { "examCode": "EXAM2027", "fileCount": 1 }
  ]
}
```

---

### List documents for an exam

Returns all scanned PDFs inside `scans/<examCode>/` with a ready-to-use preview URL for each file.

```
GET http://localhost:4545/api/docs/:examCode
```

**Example:**

```
GET http://localhost:4545/api/docs/MATH2026
```

**Success response:**

```json
{
  "success": true,
  "examCode": "MATH2026",
  "documentCount": 2,
  "documents": [
    {
      "filename": "ROLL123_MATH2026_2026-04-01T07-38-46.pdf",
      "size": 1843200,
      "createdAt": "2026-04-01T07:38:47.000Z",
      "previewUrl": "http://localhost:4545/api/docs/MATH2026/ROLL123_MATH2026_2026-04-01T07-38-46.pdf"
    },
    {
      "filename": "ROLL456_MATH2026_2026-04-01T07-45-10.pdf",
      "size": 1920000,
      "createdAt": "2026-04-01T07:45:11.000Z",
      "previewUrl": "http://localhost:4545/api/docs/MATH2026/ROLL456_MATH2026_2026-04-01T07-45-10.pdf"
    }
  ]
}
```

**Response 404** — no scans exist yet for this exam:

```json
{
  "success": false,
  "message": "No scan folder found for exam: MATH2026. No documents have been scanned for this exam yet."
}
```

---

### Preview / download a document

Streams the PDF bytes directly to the browser. Open in a `<a target="_blank">` link or embed in an `<iframe>` — the browser renders it natively using its built-in PDF viewer.

No authentication required. Intended for local network use only.

```
GET http://localhost:4545/api/docs/:examCode/:filename
```

**Example:**

```
GET http://localhost:4545/api/docs/MATH2026/ROLL123_MATH2026_2026-04-01T07-38-46.pdf
```

**Response:** PDF bytes with `Content-Type: application/pdf`

**Response 404** — file not found:

```json
{
  "success": false,
  "message": "Document not found: ROLL123_MATH2026_... in exam MATH2026"
}
```

> **Security note:** Both the exam code and filename are sanitised on the server to prevent directory traversal. Only `.pdf` files are served.

---

### Document folder structure on disk

When a scan is triggered, the service automatically creates a subfolder named after the exam code:

```
scans/
  MATH2026/
    ROLL123_MATH2026_2026-04-01T07-38-46.pdf
    ROLL456_MATH2026_2026-04-01T07-45-10.pdf
  EXAM2027/
    ROLL789_EXAM2027_2026-04-02T08-10-00.pdf
```

Each exam's documents are isolated so future exams never mix with previous ones.

---

## Output Files

**Saved to:** `scans/<examCode>/` subfolder inside this project (or inside `SCANS_DIR` if set)

**Filename format:**

```
<rollNumber>_<examCode>_<YYYY-MM-DDTHH-MM-SS>.pdf
```

**Example:**

```
ROLL123_MATH2026_2026-04-01T07-38-46.pdf
```

---

## Logs

```
logs/combined.log   — all levels (info, warn, error, http)
logs/error.log      — errors only
```

Console output is colour-coded. Set `LOG_LEVEL=debug` in `.env` for verbose output.

---

## Using a Different Scanner

### Step 1 — List detected scanners

```bash
scanimage -L
```

Example output:

```
device `v4l:/dev/video0' is a Noname Integrated Camera (webcam — skip this)
device `pixma:04A92759_01E3B00006EC' is a CANON Canon i-SENSYS MF3010
device `epson2:libusb:001:005' is a Epson GT-X820
device `hpaio:/net/HP_LaserJet?ip=192.168.1.50' is an HP LaserJet
```

### Step 2 — Pin your scanner in `.env`

```env
SANE_DEVICE=epson2:libusb:001:005
```

### Step 3 — Check what options your scanner supports

```bash
scanimage --help --device-name="epson2:libusb:001:005"
```

- `--resolution` listed → leave `SANE_SKIP_RESOLUTION=false`
- `--resolution` NOT listed → set `SANE_SKIP_RESOLUTION=true`
- `--mode` listed with values → set `SANE_MODE=Gray` or `SANE_MODE=Color`

### Common scanner backends and device prefixes

| Brand | SANE Backend | Device prefix | Install |
|-------|-------------|---------------|---------|
| Canon MF series | pixma | `pixma:` | included in `sane-utils` |
| Canon CanoScan | plustek / pixma | `plustek:` | included |
| Epson | epson2 / epsonds | `epson2:` or `epsonds:` | included |
| HP (USB) | hpaio | `hpaio:` | `sudo apt install hplip` |
| HP (network) | hpaio | `hpaio:/net/...?ip=...` | `sudo apt install hplip` |
| Brother | brscan4 | `brother4:` | download from brother.com |
| Fujitsu (ADF) | fujitsu | `fujitsu:` | included |
| Generic | varies | varies | `scanimage -L` to find |

### Network scanners (scanner on LAN, not USB)

```bash
# HP network scanner
SANE_DEVICE=hpaio:/net/HP_LaserJet_Pro?ip=192.168.1.50

# Canon via AirScan (mDNS)
sudo apt install sane-airscan
SANE_DEVICE=airscan:e0:Canon MF3010
```

### Windows — using a specific scanner with NAPS2

NAPS2 picks the Windows default scanner automatically. To use a named profile:

1. Open NAPS2 GUI → **Profiles** → **Add** → select your scanner → name it (e.g. `CanonMF3010`)
2. Set in `.env`:
   ```env
   NAPS2_PATH=C:\Program Files\NAPS2\naps2.console.exe
   NAPS2_PROFILE=CanonMF3010
   ```
3. Edit `src/services/scanService.js` — Windows command line, add:
   ```javascript
   const profileFlag = process.env.NAPS2_PROFILE ? `--profile "${process.env.NAPS2_PROFILE}"` : "";
   command = `${quoted(NAPS2_PATH)} -o ${quoted(filePath)} --noprofile ${profileFlag}`;
   ```

### macOS — selecting a specific scanner

```bash
# List available capture devices
imagesnap -l

# Test with a specific device
imagesnap -d "Canon MF3010" /tmp/test.png
```

Set in `.env`:
```env
IMAGESNAP_DEVICE=Canon MF3010
```

Then edit the darwin branch in `src/services/scanService.js`:
```javascript
const deviceFlag = process.env.IMAGESNAP_DEVICE ? `-d "${process.env.IMAGESNAP_DEVICE}"` : "";
command = `imagesnap ${deviceFlag} ${tmpPng} && ...`;
```

---

## Canon MF3010 — Linux Setup Reference

```bash
# 1. Install SANE + ImageMagick
sudo apt install sane-utils imagemagick -y

# 2. Confirm Canon is detected
scanimage -L
# Expected line: device `pixma:04A92759_xxxxxxxx' is a CANON Canon i-SENSYS MF3010

# 3. Check USB connection (if not detected)
lsusb | grep Canon
# Expected: Bus 001 Device 00x: ID 04a9:176d Canon, Inc. MF3010

# 4. Add user to scanner group (if permission denied)
sudo usermod -aG scanner $USER
# Then log out and log back in

# 5. Check all options supported by MF3010
scanimage --help --device-name="pixma:04A92759_xxxxxxxx"

# 6. Test a manual scan (place paper on flatbed first)
scanimage --device-name="pixma:04A92759_xxxxxxxx" --mode=Gray --resolution=300 --format=png -o /tmp/test.png
convert /tmp/test.png /tmp/test.pdf
ls -lh /tmp/test.pdf

# 7. Pin the device in .env
echo 'SANE_DEVICE=pixma:04A92759_xxxxxxxx' >> .env
```

---

## Troubleshooting

### "Scanner not found" / "No scanners were identified"

```bash
# Check scanner is powered on, cable connected, then:
scanimage -L

# If still not found on Linux:
sudo apt install libsane-extras -y
sudo usermod -aG scanner $USER
# Log out and back in
```

### "sane_start: Invalid argument"

Most common causes:
1. **No paper on the flatbed** — place a document and retry
2. **Scanner warming up** — wait 10–15 seconds and retry
3. Wrong scan mode for your scanner — run `scanimage --help -d <device>` to see valid `--mode` values and update `SANE_MODE` in `.env`

### "scanimage: unrecognized option '--resolution=...'"

Your scanner backend does not support `--resolution`. Set in `.env`:

```env
SANE_SKIP_RESOLUTION=true
```

### "scanimage: unrecognized option '--mode=...'"

Your scanner backend uses a different mode flag. Check:

```bash
scanimage --help --device-name="your:device"
```

Then set `SANE_MODE` to a value your scanner lists, or set it empty:

```env
SANE_MODE=
```

### "convert: not found" or "magick: not found"

```bash
sudo apt install imagemagick -y   # Linux
brew install imagemagick           # macOS
```

The service tries `convert` first, then `magick` automatically. Both commands come from the same `imagemagick` package.

### "scanimage: command not found"

```bash
sudo apt install sane-utils -y
```

### "naps2.console.exe: not found" (Windows)

Install NAPS2 from https://www.naps2.com or set:

```env
NAPS2_PATH=C:\YourCustomPath\naps2.console.exe
```

### "imagesnap: command not found" (macOS)

```bash
brew install imagesnap
```

### Scan times out

```env
# Increase timeout to 2 minutes (per page)
SCAN_TIMEOUT_MS=120000
```

### "Session not found" / "Session expired"

Multi-page scan sessions are stored in memory and auto-expire after 30 minutes (default). Possible causes:

- The session was already completed or cancelled.
- The service was restarted during a session (sessions are not persisted to disk).
- The session timed out — increase the limit:

```env
SCAN_SESSION_TIMEOUT_MS=3600000
```

### "Only X of Y pages scanned"

You must scan all declared pages before calling `/api/scan/complete`. If you cannot scan all pages (e.g., paper jam), either:

1. Cancel the session: `DELETE /api/scan/session/:sessionId`
2. Or scan the remaining pages and then complete.

### Service not reachable from React (`Failed to fetch`)

- Confirm service is running: `curl http://localhost:4545/api/health`
- Confirm port 4545 is not blocked: `sudo ufw allow 4545` (Linux)
- Confirm React app is calling `http://localhost:4545` (not https)

### Which scanner is being used? (auto-detection check)

Look at the service logs on startup of a scan:

```
Detected SANE devices: v4l:/dev/video0, pixma:04A92759_01E3B00006EC
Auto-selected device: pixma:04A92759_01E3B00006EC
```

Or check the `device` field in the API success response. Copy it to `SANE_DEVICE=` in `.env` to lock it in permanently.

---

## Project Structure

```
scaning_nodejs/
├── index.js                  Entry point — starts Express on port 4545
├── package.json              Node.js dependencies
├── start.bat                 Windows startup script
├── start.sh                  Linux/macOS startup script
├── .env                      Environment variables (create this file)
├── README.md                 This file
├── scans/                    Scanned PDF output (auto-created)
├── logs/                     Winston log files (auto-created)
│   ├── combined.log
│   └── error.log
└── src/
    ├── app.js                Express app setup (CORS, Morgan, routes)
    ├── routes/
    │   ├── scan.routes.js           GET /api/health   GET /api/scan
    │   └── scanSession.routes.js    POST /api/scan/start, /page, /complete, DELETE /session
    ├── services/
    │   ├── scanService.js           OS detection, device auto-detect, exec, multi-page merge
    │   └── sessionManager.js        In-memory multi-page scan session store + auto-cleanup
    └── utils/
        ├── logger.js         Winston logger
        └── fileHandler.js    Output path builder + file validator
```

---

## Supported Scanners

| Scanner | OS | Backend | Status |
|---------|-----|---------|--------|
| Canon i-SENSYS MF3010 | Linux | SANE pixma | Tested ✓ |
| Canon i-SENSYS MF3010 | Windows | NAPS2 | Compatible |
| Canon CanoScan series | Linux | SANE pixma/plustek | Compatible |
| Epson scanners | Linux | SANE epson2 | Compatible |
| HP scanners (USB) | Linux | SANE hpaio | Compatible |
| HP scanners (network) | Linux | SANE hpaio | Compatible |
| Any TWAIN/WIA scanner | Windows | NAPS2 | Compatible |
| Any macOS scanner | macOS | imagesnap | Compatible |

Full SANE device list: http://www.sane-project.org/sane-supported-devices.html
