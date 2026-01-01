#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

OS_NAME="$(uname -s 2>/dev/null || true)"
if [[ "$OS_NAME" != "Darwin" ]]; then
  echo "[run-bot] ERROR: This launcher is for macOS." 1>&2
  echo "[run-bot] Detected: ${OS_NAME:-unknown}" 1>&2
  echo "[run-bot] Use: run-bot.bat (Windows) | run-bot.desktop (Linux) | run-bot.sh (terminal)" 1>&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "[run-bot] ERROR: Node.js is not installed or not on PATH (requires Node >= 20)." 1>&2
  exit 1
fi

exec node ./scripts/run-bot.mjs
