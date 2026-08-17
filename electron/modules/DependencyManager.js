'use strict';
/**
 * DependencyManager.js
 *
 * Ensures all OS-level scanner/printer dependencies are present.
 * Designed for zero terminal access — teachers never need to open a terminal.
 *
 * Strategy per platform:
 *   Windows  → NAPS2 portable bundled inside app resources (no install at all)
 *   Linux    → pkexec apt-get install (GUI password dialog, no terminal)
 *   macOS    → brew install (no sudo needed) or bundled scanimage binary
 *
 * Usage (in electron/main.js):
 *   const DependencyManager = require('./modules/DependencyManager');
 *   // After tray is created, run non-blocking:
 *   setTimeout(() => DependencyManager.ensureAll(store, log).catch(log.error), 2000);
 */

const path         = require('path');
const fs           = require('fs');
const { execSync, execFile, spawnSync } = require('child_process');
const { dialog, shell, app } = require('electron');

// ─── Platform flags ──────────────────────────────────────────────────────────
const IS_WIN   = process.platform === 'win32';
const IS_LINUX = process.platform === 'linux';
const IS_MAC   = process.platform === 'darwin';

// ─── Bundled resource paths ───────────────────────────────────────────────────
// These paths work both in dev (from project root) and in packaged Electron app.
// electron-builder copies extraResources into process.resourcesPath at build time.
const RESOURCES_PATH = app.isPackaged
  ? process.resourcesPath
  : path.join(__dirname, '..', '..', 'resources');

// Windows: NAPS2 portable is extracted into resources/naps2/
const BUNDLED_NAPS2 = path.join(RESOURCES_PATH, 'naps2', 'naps2.console.exe');

// macOS fallback: bundled scanimage binary in resources/bin/
const BUNDLED_SCANIMAGE_MAC = path.join(RESOURCES_PATH, 'bin', 'scanimage');

// ─── Main entry point ─────────────────────────────────────────────────────────
/**
 * Run all dependency checks. Automatically installs what's missing.
 * Shows GUI dialogs if user action is needed. Never opens a terminal.
 *
 * @param {import('electron-store')} store  - electron-store instance for flags
 * @param {import('electron-log')}   log    - electron-log instance
 */
async function ensureAll(store, log) {
  log.info('[DependencyManager] Running dependency checks...');

  if (IS_WIN)   await ensureWindows(store, log);
  if (IS_LINUX) await ensureLinux(store, log);
  if (IS_MAC)   await ensureMac(store, log);

  log.info('[DependencyManager] All checks complete.');
}

// ─────────────────────────────────────────────────────────────────────────────
//  WINDOWS
// ─────────────────────────────────────────────────────────────────────────────
async function ensureWindows(store, log) {
  // Step 1: Check if bundled NAPS2 exists inside the app resources
  if (fs.existsSync(BUNDLED_NAPS2)) {
    log.info('[DependencyManager] Windows: Bundled NAPS2 found at ' + BUNDLED_NAPS2);
    // Export path for scanService to pick up
    process.env.NAPS2_PATH = BUNDLED_NAPS2;
    return;
  }

  // Step 2: Check if NAPS2 is installed system-wide (user may have installed it before)
  const systemPaths = [
    'C:\\Program Files\\NAPS2\\naps2.console.exe',
    'C:\\Program Files (x86)\\NAPS2\\naps2.console.exe',
    process.env.NAPS2_PATH,
  ].filter(Boolean);

  const systemNaps2 = systemPaths.find(p => fs.existsSync(p));
  if (systemNaps2) {
    log.info('[DependencyManager] Windows: System NAPS2 found at ' + systemNaps2);
    process.env.NAPS2_PATH = systemNaps2;
    return;
  }

  // Step 3: NAPS2 is missing — this should not happen in production builds
  // because it's bundled. But handle gracefully for dev or broken installs.
  log.warn('[DependencyManager] Windows: NAPS2 not found. Showing install dialog.');

  if (store.get('naps2InstallShown')) return; // Only show once per install
  store.set('naps2InstallShown', true);

  const { response } = await dialog.showMessageBox({
    type:      'warning',
    title:     'Scanner Setup',
    message:   'Scanner software (NAPS2) is missing.',
    detail:    'This app bundles NAPS2 automatically. If you see this message,\n' +
               'try reinstalling the app.\n\n' +
               'Alternatively, download and install NAPS2 manually (free, ~30 MB),\n' +
               'then restart this app.',
    buttons:   ['Download NAPS2 (free)', 'Skip for now'],
    defaultId: 0,
  });

  if (response === 0) shell.openExternal('https://www.naps2.com');
}

// ─────────────────────────────────────────────────────────────────────────────
//  LINUX
// ─────────────────────────────────────────────────────────────────────────────
async function ensureLinux(store, log) {
  const missing = [];

  // Check scanimage
  if (!commandExists('scanimage')) {
    missing.push('sane-utils');
  }

  // Check sane-airscan (needed for WiFi/network scanners — Canon, HP, Epson)
  // Detect by checking if /etc/sane.d/airscan.conf exists or scanimage lists airscan backend
  if (!saneAirscanPresent()) {
    missing.push('sane-airscan');
  }

  // Check lp (CUPS) — usually pre-installed on Ubuntu Desktop
  if (!commandExists('lp')) {
    missing.push('cups');
  }

  if (missing.length === 0) {
    log.info('[DependencyManager] Linux: All dependencies present.');
    return;
  }

  log.warn('[DependencyManager] Linux: Missing packages: ' + missing.join(', '));

  // Try auto-install via pkexec (shows a GUI password dialog, no terminal needed)
  const autoInstalled = await tryPkexecInstall(missing, log);
  if (autoInstalled) {
    log.info('[DependencyManager] Linux: Auto-install succeeded.');
    return;
  }

  // pkexec failed or not available — show a dialog with manual instructions
  if (store.get('linuxDepsShown')) return;
  store.set('linuxDepsShown', true);

  const installCmd = `sudo apt install -y ${missing.join(' ')}`;

  await dialog.showMessageBox({
    type:    'warning',
    title:   'Printer & Scanner Setup',
    message: 'Some required tools need to be installed.',
    detail:  'Open a terminal and run:\n\n' +
             installCmd +
             '\n\nThen restart this app.\n\n' +
             'Note: WiFi/network scanners also need sane-airscan.',
    buttons: ['OK'],
  });
}

/**
 * Try to install packages using pkexec (PolicyKit) — shows a GUI password
 * dialog instead of requiring a terminal. Available on all Ubuntu/GNOME desktops.
 */
async function tryPkexecInstall(packages, log) {
  return new Promise(resolve => {
    // Check pkexec is available
    if (!commandExists('pkexec')) {
      log.warn('[DependencyManager] pkexec not found — cannot auto-install.');
      resolve(false);
      return;
    }

    // pkexec runs the command as root with a GUI auth dialog
    const args = ['apt-get', 'install', '-y', ...packages];
    log.info('[DependencyManager] Running: pkexec ' + args.join(' '));

    const proc = require('child_process').spawn('pkexec', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });

    proc.on('close', code => {
      if (code === 0) {
        resolve(true);
      } else {
        log.warn('[DependencyManager] pkexec install failed (code ' + code + '): ' + stderr);
        resolve(false);
      }
    });

    proc.on('error', err => {
      log.warn('[DependencyManager] pkexec spawn error: ' + err.message);
      resolve(false);
    });
  });
}

function saneAirscanPresent() {
  // Check for airscan config file (installed by sane-airscan package)
  const airscanConf = '/etc/sane.d/airscan.conf';
  if (fs.existsSync(airscanConf)) return true;
  // Also check if the lib is present
  const airscanLib = '/usr/lib/sane/libsane-airscan.so';
  if (fs.existsSync(airscanLib)) return true;
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
//  macOS
// ─────────────────────────────────────────────────────────────────────────────
async function ensureMac(store, log) {
  // Step 1: Check if scanimage is already on PATH
  if (commandExists('scanimage')) {
    log.info('[DependencyManager] macOS: scanimage found on PATH.');
    return;
  }

  // Step 2: Check common Homebrew install locations
  const brewPaths = [
    '/usr/local/bin/scanimage',   // Intel Mac
    '/opt/homebrew/bin/scanimage', // Apple Silicon
  ];
  const brewScanimage = brewPaths.find(p => fs.existsSync(p));
  if (brewScanimage) {
    log.info('[DependencyManager] macOS: scanimage found at ' + brewScanimage);
    process.env.PATH = path.dirname(brewScanimage) + ':' + process.env.PATH;
    return;
  }

  // Step 3: Check for bundled binary (included in .dmg via extraResources)
  if (fs.existsSync(BUNDLED_SCANIMAGE_MAC)) {
    log.info('[DependencyManager] macOS: Using bundled scanimage binary.');
    // Make it executable
    try { fs.chmodSync(BUNDLED_SCANIMAGE_MAC, 0o755); } catch {}
    process.env.PATH = path.dirname(BUNDLED_SCANIMAGE_MAC) + ':' + process.env.PATH;
    return;
  }

  // Step 4: Try auto-install via Homebrew (no sudo needed)
  const hasHomebrew = commandExists('brew') ||
                      fs.existsSync('/usr/local/bin/brew') ||
                      fs.existsSync('/opt/homebrew/bin/brew');

  if (hasHomebrew) {
    log.info('[DependencyManager] macOS: Homebrew found — attempting auto-install.');
    const installed = await tryBrewInstall(log);
    if (installed) return;
  }

  // Step 5: Show guided setup dialog
  if (store.get('macSaneShown')) return;
  store.set('macSaneShown', true);

  const { response } = await dialog.showMessageBox({
    type:    'info',
    title:   'Scanner Setup (one-time)',
    message: 'Scanner drivers need to be installed.',
    detail:  hasHomebrew
      ? 'Click "Install Now" and we\'ll set it up automatically.\n\n' +
        'This takes about 1 minute and requires no technical knowledge.'
      : 'Open Terminal and run:\n\n' +
        '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"\n\n' +
        'Then restart this app and we\'ll finish the setup automatically.',
    buttons: hasHomebrew
      ? ['Install Now (automatic)', 'Skip']
      : ['Open Terminal Guide', 'Skip'],
    defaultId: 0,
  });

  if (response === 0) {
    if (hasHomebrew) {
      // Show a progress window and run brew install
      await runBrewInstallWithProgress(log);
    } else {
      shell.openExternal('https://brew.sh');
    }
  }
}

/**
 * Run `brew install sane-backends sane-airscan` silently.
 * Homebrew does not require sudo — safe to run from Electron main process.
 */
async function tryBrewInstall(log) {
  return new Promise(resolve => {
    const brewBin = fs.existsSync('/opt/homebrew/bin/brew')
      ? '/opt/homebrew/bin/brew'
      : '/usr/local/bin/brew';

    const args = ['install', 'sane-backends', 'sane-airscan'];
    log.info('[DependencyManager] Running: ' + brewBin + ' ' + args.join(' '));

    const proc = require('child_process').spawn(brewBin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HOME: require('os').homedir() },
    });

    proc.stdout.on('data', d => log.info('[brew] ' + d.toString().trim()));
    proc.stderr.on('data', d => log.warn('[brew] ' + d.toString().trim()));

    proc.on('close', code => {
      if (code === 0) {
        // Add brew bin to PATH for current process
        const brewBinDir = path.dirname(brewBin);
        process.env.PATH = brewBinDir + ':' + process.env.PATH;
        resolve(true);
      } else {
        log.warn('[DependencyManager] brew install failed with code ' + code);
        resolve(false);
      }
    });

    proc.on('error', err => {
      log.warn('[DependencyManager] brew spawn error: ' + err.message);
      resolve(false);
    });
  });
}

/**
 * Same as tryBrewInstall but shows a progress dialog so the teacher
 * knows something is happening (brew takes ~1 min to compile).
 */
async function runBrewInstallWithProgress(log) {
  // Show a non-blocking info message
  const progressWin = new (require('electron').BrowserWindow)({
    width:  420,
    height: 160,
    frame:  false,
    resizable: false,
    alwaysOnTop: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });

  progressWin.loadURL('data:text/html,<body style="font-family:system-ui;padding:24px;background:#1e1e1e;color:#fff">' +
    '<h3 style="margin:0 0 8px">Installing scanner drivers…</h3>' +
    '<p style="margin:0;color:#aaa">This takes about 1–2 minutes. Please wait.</p>' +
    '</body>');

  const ok = await tryBrewInstall(log);
  progressWin.close();

  if (ok) {
    await dialog.showMessageBox({
      type:    'info',
      title:   'Setup Complete',
      message: 'Scanner drivers installed successfully.',
      detail:  'You can now scan documents. No restart needed.',
      buttons: ['OK'],
    });
  } else {
    await dialog.showMessageBox({
      type:    'error',
      title:   'Setup Failed',
      message: 'Could not install scanner drivers automatically.',
      detail:  'Open Terminal and run:\n\nbrew install sane-backends sane-airscan\n\nThen restart this app.',
      buttons: ['OK'],
    });
  }
}

// ─── Utility ──────────────────────────────────────────────────────────────────
function commandExists(cmd) {
  try {
    const which = IS_WIN ? 'where' : 'which';
    execSync(`${which} ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
module.exports = { ensureAll };
