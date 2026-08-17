# OS-Level Dependencies — Complete Guide

**Updated after full codebase review (August 2026)**

---

## The Good News First — What You Do NOT Need to Install

Your codebase already uses pure npm packages for the heavy lifting:

| Task | What you might expect | What's actually used |
|---|---|---|
| HTML → PDF (printing) | Need Chromium | ✅ Puppeteer **bundles its own Chromium** |
| PNG → PDF (scanning) | Need ImageMagick | ✅ `pdf-lib` (pure JS, npm install) |
| PNG compression | Need ImageMagick | ✅ `sharp` (npm, prebuilt native binaries) |
| Windows printing | Need printer driver config | ✅ `pdf-to-printer` **bundles SumatraPDF** |
| Windows scan → PDF | Need Ghostscript | ✅ NAPS2 handles it internally |

**ImageMagick is already gone from the codebase.** `scanService.js` uses `sharp` + `pdf-lib`. The AUDIT.md note about ImageMagick was based on an older version. Your current code is already clean.

---

## What Still Needs OS-Level Installation

### Platform Summary

| Dependency | Windows | Ubuntu/Linux | macOS |
|---|---|---|---|
| **NAPS2** (scanner app) | 🔴 Must install manually | ❌ Not needed | ❌ Not needed |
| **sane-utils** (scanimage) | ❌ Not needed | 🔴 Must install | 🔴 Must install |
| **sane-airscan** (network scanners) | ❌ Not needed | 🟡 Needed for WiFi printers | 🟡 Needed for WiFi printers |
| **CUPS** (print spooler) | ❌ Not needed | 🟢 Usually pre-installed | 🟢 Pre-installed on macOS |
| **Homebrew** | ❌ Not needed | ❌ Not needed | 🟡 Needed to install SANE |
| **Node.js** | ⚪ Auto-installed by start.bat | ⚪ Auto-installed by start.sh | ⚪ Auto-installed by start.sh |

---

## Platform-by-Platform Detail

---

### 🪟 Windows

#### Required: NAPS2

**What it is:** A full scanner application that exposes a CLI. Your service calls
`naps2.console.exe -o output.pdf --noprofile` to trigger a scan.

**Why you can't avoid it:** Windows scanner access requires WIA (Windows Image Acquisition)
or TWAIN drivers. There is no cross-scanner CLI tool built into Windows. NAPS2 is the
best free option that works with virtually every scanner brand.

**Install:**
```
Download from: https://www.naps2.com
File: naps2-x.x.x-setup.exe  (~30 MB)
Default install path: C:\Program Files\NAPS2\
```

**Scanner compatibility:** Works with USB scanners, network scanners, and ADF (auto-feeder)
scanners via WIA. Covers Canon, HP, Epson, Brother, and virtually all others.

**Nothing else needed on Windows:**
- Printing ✅ — `pdf-to-printer` bundles SumatraPDF internally
- PDF generation ✅ — `pdf-lib` + `sharp` are npm packages
- HTML rendering ✅ — Puppeteer bundles Chromium

---

### 🐧 Ubuntu / Linux

#### Required: sane-utils

**What it is:** The `scanimage` command-line tool. Your service calls
`scanimage --device-name="..." --mode=Gray --format=png -o file.png`.

```bash
sudo apt install sane-utils
# Verify:
scanimage --version   # should print: scanimage (sane-backends) 1.x.x
```

#### Required for WiFi / Network Scanners: sane-airscan

If the printer/scanner connects over WiFi (eSCL / AirScan protocol — Canon, HP, Epson
network printers all use this), you need `sane-airscan` too.

```bash
sudo apt install sane-airscan
# Verify:
scanimage -L  # should list your network scanner as "airscan:eN:Model Name"
```

**Without this:** USB scanners still work. Network/WiFi scanners show "no devices found."

#### CUPS (Printing) — Usually Already There

Ubuntu Desktop and Server both install CUPS by default. The `lp` command your service
uses is part of CUPS.

```bash
# Check if CUPS is installed:
lpstat -v
# If not installed:
sudo apt install cups
```

**Nothing else needed on Linux:**
- PDF generation ✅ — `pdf-lib` + `sharp` (npm prebuilt binaries)
- HTML rendering ✅ — Puppeteer bundles Chromium

---

### 🍎 macOS

#### Required: sane-backends + sane-airscan (via Homebrew)

macOS does not ship with `scanimage`. You install it via Homebrew.

```bash
# Install Homebrew first (if not present):
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Then install SANE:
brew install sane-backends
brew install sane-airscan   # for WiFi/AirScan scanners

# Verify:
scanimage -L
```

**CUPS** is pre-installed on macOS (has been since OS X 10.6). No action needed.

**Nothing else needed on macOS:**
- PDF generation ✅ — `pdf-lib` + `sharp`
- HTML rendering ✅ — Puppeteer bundles Chromium
- Printing ✅ — CUPS `lp` command is pre-installed

---

## Electron App Strategy — Auto-Handle vs Manual

When you wrap this in the Electron app, some of these can be detected and guided
automatically. Here's exactly what the Electron app should do per platform:

---

### Windows Strategy — Auto-detect NAPS2, Guide Install

```js
// electron/modules/DependencyChecker.js
const { dialog, shell } = require('electron');
const Store = require('electron-store');
const fs    = require('fs');
const path  = require('path');
const { IS_WINDOWS } = require('../../shared/platform');

async function checkWindows(store) {
  if (!IS_WINDOWS) return;

  const naps2Path = process.env.NAPS2_PATH
    || 'C:\\Program Files\\NAPS2\\naps2.console.exe';

  if (fs.existsSync(naps2Path)) return; // all good

  // Only warn once — store the flag
  if (store.get('naps2WarnShown')) return;
  store.set('naps2WarnShown', true);

  const { response } = await dialog.showMessageBox({
    type:    'warning',
    title:   'Scanner Setup Required',
    message: 'NAPS2 is required for scanning on Windows.',
    detail:  'NAPS2 is a free scanner app that this service uses to\n' +
             'communicate with your printer/scanner.\n\n' +
             'Click "Download NAPS2" to get it (~30 MB).\n' +
             'After installing, restart Print & Scan Service.',
    buttons: ['Download NAPS2', 'Skip for now'],
    defaultId: 0,
  });

  if (response === 0) shell.openExternal('https://www.naps2.com');
}

module.exports = { checkWindows };
```

---

### Linux Strategy — Auto-check, Show Install Commands

```js
// electron/modules/DependencyChecker.js (Linux section)
const { execSync } = require('child_process');
const { dialog }   = require('electron');
const { IS_LINUX } = require('../../shared/platform');

async function checkLinux() {
  if (!IS_LINUX) return;

  const missing = [];

  try { execSync('scanimage --version', { stdio: 'ignore' }); }
  catch { missing.push('scanimage  →  sudo apt install sane-utils'); }

  try { execSync('lpstat --version 2>/dev/null || lp --version', { stdio: 'ignore' }); }
  catch { missing.push('lp (CUPS)  →  sudo apt install cups'); }

  if (missing.length === 0) return;

  await dialog.showMessageBox({
    type:    'warning',
    title:   'Missing Scanner/Printer Tools',
    message: 'Some required tools are not installed.',
    detail:  'Run these commands in your terminal, then restart:\n\n' +
             missing.join('\n\n') +
             '\n\n(Network/WiFi scanners also need: sudo apt install sane-airscan)',
    buttons: ['OK'],
  });
}

module.exports = { checkLinux };
```

---

### macOS Strategy — Guide Homebrew + SANE Install

```js
// electron/modules/DependencyChecker.js (macOS section)
const { execSync } = require('child_process');
const { dialog, shell } = require('electron');
const { IS_MAC } = require('../../shared/platform');

async function checkMac(store) {
  if (!IS_MAC) return;

  try { execSync('scanimage --version', { stdio: 'ignore' }); return; }
  catch {}

  if (store.get('macSaneWarnShown')) return;
  store.set('macSaneWarnShown', true);

  // Check if Homebrew is even installed
  let hasHomebrew = false;
  try { execSync('brew --version', { stdio: 'ignore' }); hasHomebrew = true; }
  catch {}

  const detail = hasHomebrew
    ? 'Run in Terminal:\n\nbrew install sane-backends\nbrew install sane-airscan\n\nThen restart Print & Scan Service.'
    : 'First install Homebrew from https://brew.sh\n\nThen run:\nbrew install sane-backends\nbrew install sane-airscan';

  const { response } = await dialog.showMessageBox({
    type:    'warning',
    title:   'Scanner Setup Required',
    message: 'scanimage (SANE) is required for scanning on macOS.',
    detail,
    buttons: hasHomebrew ? ['OK'] : ['Open brew.sh', 'OK'],
  });

  if (!hasHomebrew && response === 0) shell.openExternal('https://brew.sh');
}

module.exports = { checkMac };
```

---

### Wire into `electron/main.js`

```js
// In app.whenReady(), after tray.create():
const { checkWindows, checkLinux, checkMac } = require('./modules/DependencyChecker');

// Run checks non-blocking, 2 seconds after startup
setTimeout(async () => {
  await checkWindows(store).catch(log.error);
  await checkLinux().catch(log.error);
  await checkMac(store).catch(log.error);
}, 2000);
```

---

## The `.deb` Package Handles Linux Automatically

The `electron-builder.yml` config already has:

```yaml
deb:
  depends:
    - sane-utils
    - libnotify4
```

When a user installs your `.deb` package (`sudo dpkg -i print-scan-service.deb` or via
the Software Center), `apt` will automatically install `sane-utils` as a dependency.
They never see an error — it just installs.

Add `sane-airscan` to the depends list too:

```yaml
deb:
  depends:
    - sane-utils
    - sane-airscan
    - libnotify4
    - cups
```

---

## Final "Zero Extra Steps" Checklist Per Platform

### Windows (after Electron .exe install)
- [x] Node.js — **bundled in Electron app**
- [x] Puppeteer/Chromium — **bundled in npm**
- [x] SumatraPDF (printing) — **bundled in pdf-to-printer**
- [x] pdf-lib + sharp (PDF generation) — **bundled in npm**
- [ ] NAPS2 — **user must install once** (Electron app prompts with download link)

**User effort: Download and run one 30 MB installer. That's it.**

---

### Ubuntu / Linux (via .deb package)
- [x] Node.js — **bundled in Electron app**
- [x] Puppeteer/Chromium — **bundled in npm**
- [x] pdf-lib + sharp (PDF generation) — **bundled in npm**
- [x] sane-utils — **auto-installed via .deb Depends**
- [x] sane-airscan — **auto-installed via .deb Depends**
- [x] CUPS — **pre-installed on Ubuntu Desktop** (added to .deb Depends as fallback)

**User effort: Double-click the .deb file. Zero extra steps.**

---

### Ubuntu / Linux (via .AppImage)
- [x] Node.js — **bundled in Electron app**
- [x] Puppeteer/Chromium — **bundled in npm**
- [x] pdf-lib + sharp — **bundled in npm**
- [ ] sane-utils — **user must install** (app shows dialog with command)
- [ ] sane-airscan — **user must install** (app shows dialog with command)
- [x] CUPS — **pre-installed on Ubuntu Desktop**

**User effort: Run one `sudo apt install` command. App tells them exactly what to type.**

---

### macOS (via .dmg)
- [x] Node.js — **bundled in Electron app**
- [x] Puppeteer/Chromium — **bundled in npm**
- [x] pdf-lib + sharp — **bundled in npm**
- [x] CUPS — **pre-installed on macOS**
- [ ] sane-backends + sane-airscan — **user must install via Homebrew**
  - App shows dialog → user runs `brew install sane-backends sane-airscan`
  - If Homebrew not present → app links to brew.sh first

**User effort: Install Homebrew (if not present) + run one brew command. App guides them.**

---

## Summary Table — One-Line Per Platform

| Platform | Distribution | Extra user steps |
|---|---|---|
| Windows | `.exe` installer | Install NAPS2 once (app prompts with link) |
| Ubuntu | `.deb` package | **Zero** — sane-utils auto-installed by apt |
| Ubuntu | `.AppImage` | Run `sudo apt install sane-utils sane-airscan` |
| macOS | `.dmg` | Run `brew install sane-backends sane-airscan` |

---

*End of Dependencies Guide · August 2026*
