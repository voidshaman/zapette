#!/bin/sh
# POSIX launcher. The logic lives in run.mjs so every platform behaves the same,
# including the search for a Node 26.4+ (OpenTUI's native core needs FFI).
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if [ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ]; then
  exec "$NODE_BIN" "$here/run.mjs" "$@"
fi
if command -v node >/dev/null 2>&1; then
  exec node "$here/run.mjs" "$@"
fi
if [ -x "$HOME/.hermes/node/bin/node" ]; then
  exec "$HOME/.hermes/node/bin/node" "$here/run.mjs" "$@"
fi

echo "tv-remote-tui: needs Node 26.4 or newer, or NODE_BIN pointing at one" >&2
exit 1
