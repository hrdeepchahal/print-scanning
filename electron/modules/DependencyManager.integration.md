# How to wire DependencyManager into electron/main.js

Add these two lines to your `electron/main.js` after the tray is created:

```js
// At the top of main.js — add this require:
const DependencyManager = require('./modules/DependencyManager');

// Inside app.whenReady(), AFTER tray.create() — add this:
// Run dependency check 2 seconds after startup (non-blocking)
// Teachers see the tray icon immediately; install dialog appears shortly after if needed
setTimeout(() => {
  DependencyManager.ensureAll(store, log).catch(err => {
    log.error('[DependencyManager] Unexpected error:', err);
  });
}, 2000);
```

## What teachers experience on each platform

### Windows
If NAPS2 is correctly bundled in `resources/naps2/` (see electron-builder.yml),
teachers see **nothing at all** — it just works silently on first launch.

If NAPS2 is somehow missing (e.g., broken AppImage from another machine),
they see a single dialog with a "Download NAPS2" button. One click, done.

### Ubuntu (installed via .deb)
Teachers see **nothing** — apt installs sane-utils and sane-airscan automatically
when they install the .deb package. No dialogs, no terminal, no steps.

### Ubuntu (installed via .AppImage)
On first launch, if sane-utils is missing, the app shows a **GUI password dialog**
(same as when you install something from the Ubuntu Software Center). Teacher
enters their password, packages install automatically in the background.

### macOS
**If Homebrew is already installed** (common on developer machines or if IT pre-installed it):
The app shows a one-click "Install Now" dialog. Teacher clicks it, sees a progress
window ("Installing scanner drivers…"), done in ~1 minute. No terminal.

**If Homebrew is NOT installed:**
Dialog shows a Homebrew install URL. Teacher clicks "Open brew.sh" — they follow
the Homebrew one-liner. Then restart the app, and sane-backends installs automatically.

**If a bundled scanimage binary is in resources/bin/:**
No dialog shown at all — works silently, same as Windows.

## Preparing the bundled NAPS2 (Windows only)

1. Download NAPS2 portable ZIP from https://www.naps2.com/download
   (look for "Portable" option, not the installer)
2. Extract it into your project:
   ```
   project-root/
   └── resources/
       └── naps2/
           ├── naps2.console.exe   ← the CLI binary used by scanService.js
           ├── NAPS2.exe           ← optional GUI (not needed for service)
           └── *.dll               ← all required DLLs
   ```
3. `electron-builder.yml` already has `extraResources` configured to include this
   folder only on Windows builds.
4. Add `resources/naps2/` to your `.gitignore` — don't commit the binaries.

## Preparing bundled scanimage (macOS — optional)

This is optional — only needed if you want zero-setup even without Homebrew.

```bash
# On an Intel Mac with Homebrew:
brew install sane-backends sane-airscan
cp /usr/local/bin/scanimage resources/bin/scanimage

# On Apple Silicon Mac with Homebrew:
brew install sane-backends sane-airscan
cp /opt/homebrew/bin/scanimage resources/bin/scanimage
```

Note: You may need to bundle required dylibs too. Use `otool -L resources/bin/scanimage`
to check dependencies and copy any non-system libs alongside it.
