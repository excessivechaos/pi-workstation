#!/bin/sh
# pi-workstation bootstrap (macOS / Linux / Git Bash on Windows)
#
# Runs next to a checkout, or standalone from a pipe:
#   curl -fsSL https://raw.githubusercontent.com/excessivechaos/pi-workstation/main/install.sh | sh
#
# Every argument is passed through, e.g.:
#   sh install.sh --dry-run
#   sh install.sh --agent-dir "$HOME/.pi/agent"
set -eu

REPO=https://github.com/excessivechaos/pi-workstation
BRANCH=main

cleanup_dir=
cleanup() { [ -n "$cleanup_dir" ] && rm -rf "$cleanup_dir"; }
trap cleanup EXIT INT TERM

# Where is bootstrap.mjs? Next to this script when cloned; otherwise fetch the repo into a temp dir
# (nothing is left behind, and nothing lands in the current directory).
here=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd || echo "")
bootstrap="$here/bootstrap.mjs"
if [ ! -f "$bootstrap" ]; then
  echo "fetching $REPO ($BRANCH)..."
  cleanup_dir=$(mktemp -d)
  curl -fsSL "$REPO/archive/refs/heads/$BRANCH.tar.gz" | tar -xz -C "$cleanup_dir"
  bootstrap="$cleanup_dir/pi-workstation-$BRANCH/bootstrap.mjs"
fi

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

exec node "$bootstrap" --skip-pi-install "$@"
