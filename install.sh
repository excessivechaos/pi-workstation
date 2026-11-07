#!/bin/sh
# pi-workstation bootstrap (macOS / Linux / Git Bash on Windows)
#
# Installs pi (and Node, if the official installer needs to), then runs bootstrap.mjs.
# Every argument is passed through, e.g.:
#   ./install.sh --dry-run
#   ./install.sh --agent-dir "$HOME/.pi/agent"
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if ! command -v pi >/dev/null 2>&1; then
  echo "installing pi..."
  if ! curl -fsSL https://pi.dev/install.sh | sh; then
    echo "pi installer failed" >&2
    exit 1
  fi
  # The installer may add a path entry that this shell has not read yet.
  for candidate in "$HOME/.local/bin" "$HOME/.pi/agent/bin"; do
    [ -d "$candidate" ] && PATH="$candidate:$PATH"
  done
  export PATH
fi

if ! command -v node >/dev/null 2>&1; then
  echo "node is not on PATH; pi's installer normally provides it. Install Node 22.19+ and rerun." >&2
  exit 1
fi

exec node "$here/bootstrap.mjs" --skip-pi-install "$@"
