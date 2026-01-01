#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

fail() {
  echo "[run-bot] ERROR: $*" 1>&2
  exit 1
}

if ! command -v node >/dev/null 2>&1; then
  fail "Node.js is not installed or not on PATH (requires Node >= 20)."
fi

exec node ./scripts/run-bot.mjs
