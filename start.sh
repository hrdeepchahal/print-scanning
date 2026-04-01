#!/usr/bin/env bash

set -euo pipefail

echo "============================================"
echo "  Print Scanning Service (port 4545)"
echo "============================================"
echo ""

# ── Node.js check ────────────────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  echo "[ERROR] Node.js is not installed."
  echo ""
  echo "Install options:"
  echo "  Ubuntu/Debian : sudo apt install nodejs npm"
  echo "  macOS (Homebrew): brew install node"
  echo "  Or download from: https://nodejs.org"
  echo ""
  exit 1
fi

NODE_VERSION=$(node --version)
echo "[OK] Node.js found: $NODE_VERSION"

# ── npm check ────────────────────────────────────────────────────────────────
if ! command -v npm &>/dev/null; then
  echo "[ERROR] npm is not available. Reinstall Node.js from https://nodejs.org"
  exit 1
fi

echo "[OK] npm found."
echo ""

# ── OS-specific scanner dependency check ─────────────────────────────────────
OS="$(uname -s)"

if [ "$OS" = "Linux" ]; then
  echo "[INFO] Platform: Linux"
  MISSING=""

  if ! command -v scanimage &>/dev/null; then
    MISSING="$MISSING scanimage(sane-utils)"
  fi
  if ! command -v convert &>/dev/null; then
    MISSING="$MISSING convert(imagemagick)"
  fi

  if [ -n "$MISSING" ]; then
    echo ""
    echo "[WARN] Missing scanner dependencies:$MISSING"
    echo "Install them with:"
    echo "  sudo apt install sane-utils imagemagick"
    echo ""
    echo "Continuing startup — scan calls will fail until these are installed."
    echo ""
  else
    echo "[OK] scanimage and convert are available."
    echo ""
  fi

elif [ "$OS" = "Darwin" ]; then
  echo "[INFO] Platform: macOS"

  if ! command -v imagesnap &>/dev/null; then
    echo "[WARN] imagesnap not found. Install: brew install imagesnap"
  fi
  if ! command -v convert &>/dev/null; then
    echo "[WARN] ImageMagick not found. Install: brew install imagemagick"
  fi
  echo ""
fi

# ── Install Node dependencies if missing ─────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [ ! -d "node_modules" ]; then
  echo "[INFO] Installing Node.js dependencies..."
  echo ""
  npm install
  echo ""
  echo "[OK] Dependencies installed."
  echo ""
fi

# ── Start the service ────────────────────────────────────────────────────────
echo "[INFO] Starting scanning service on port 4545..."
echo "[INFO] Press Ctrl+C to stop."
echo ""
node index.js
