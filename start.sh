#!/usr/bin/env bash

set -euo pipefail

echo "============================================"
echo "  Print Scanning Service (port 4545)"
echo "============================================"
echo ""

# ── Node.js check / auto-install ─────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  echo "[WARN] Node.js is not installed. Attempting to install it automatically..."
  echo ""

  OS="$(uname -s)"

  if [ "$OS" = "Linux" ] && command -v apt-get &>/dev/null; then
    echo "[INFO] Detected Ubuntu/Debian — installing latest Node.js LTS via NodeSource..."
    curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
    sudo apt-get install -y nodejs

  elif [ "$OS" = "Darwin" ]; then
    echo "[INFO] Detected macOS — installing latest Node.js via Homebrew..."
    if ! command -v brew &>/dev/null; then
      echo "[ERROR] Homebrew is not installed. Install it first: https://brew.sh"
      exit 1
    fi
    brew install node

  else
    echo "[ERROR] Don't know how to auto-install Node.js on this OS ($OS)."
    echo ""
    echo "Install options:"
    echo "  Ubuntu/Debian   : sudo apt install nodejs npm"
    echo "  macOS (Homebrew): brew install node"
    echo "  Or download from: https://nodejs.org"
    echo ""
    exit 1
  fi

  if ! command -v node &>/dev/null; then
    echo "[ERROR] Node.js installation failed. Install it manually from https://nodejs.org"
    exit 1
  fi

  echo ""
  echo "[OK] Node.js installed successfully."
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

# ── Free the port if something is already using it ──────────────────────────
PORT=4545

find_port_pids() {
  if command -v lsof &>/dev/null; then
    lsof -ti tcp:"$PORT" 2>/dev/null || true
  elif command -v fuser &>/dev/null; then
    fuser "$PORT"/tcp 2>/dev/null | tr -s ' ' '\n' | grep -E '^[0-9]+$' || true
  else
    echo ""
  fi
}

EXISTING_PIDS="$(find_port_pids)"

if [ -n "$EXISTING_PIDS" ]; then
  echo "[WARN] Port $PORT is already in use (PID: $(echo "$EXISTING_PIDS" | tr '\n' ' ')). Stopping it..."
  kill $EXISTING_PIDS 2>/dev/null || true

  for _ in 1 2 3 4 5; do
    sleep 1
    EXISTING_PIDS="$(find_port_pids)"
    [ -z "$EXISTING_PIDS" ] && break
  done

  if [ -n "$EXISTING_PIDS" ]; then
    echo "[WARN] Still running after 5s — forcing kill (PID: $(echo "$EXISTING_PIDS" | tr '\n' ' '))."
    kill -9 $EXISTING_PIDS 2>/dev/null || true
    sleep 1
  fi

  echo "[OK] Port $PORT is free."
  echo ""
elif ! command -v lsof &>/dev/null && ! command -v fuser &>/dev/null; then
  echo "[WARN] Neither lsof nor fuser is available — cannot check if port $PORT is busy."
  echo "       If startup fails with EADDRINUSE, stop the other process manually."
  echo ""
fi

# ── Start the service ────────────────────────────────────────────────────────
echo "[INFO] Starting scanning service on port 4545..."
echo "[INFO] Press Ctrl+C to stop."
echo ""
node index.js
