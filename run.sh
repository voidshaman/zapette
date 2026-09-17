#!/bin/sh
# OpenTUI's native core needs Node.js >= 26.4 with FFI enabled, so don't just
# trust whatever `node` is first on PATH (nvm may hand us an older one).
set -e

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

usable() {
  [ -n "$1" ] || return 1
  [ -x "$1" ] || return 1
  v=$("$1" -p 'process.versions.node' 2>/dev/null) || return 1
  major=${v%%.*}
  minor=$(printf '%s' "${v#*.}" | cut -d. -f1)
  [ "$major" -gt 26 ] 2>/dev/null && return 0
  [ "$major" -eq 26 ] 2>/dev/null && [ "$minor" -ge 4 ] 2>/dev/null && return 0
  return 1
}

# NODE_BIN wins; then PATH; then a couple of common per-user installs.
candidates="$NODE_BIN $(command -v node 2>/dev/null) $HOME/.hermes/node/bin/node"
for dir in "$HOME"/.nvm/versions/node/*/bin; do
  [ -d "$dir" ] && candidates="$candidates $dir/node"
done

for candidate in $candidates; do
  if usable "$candidate"; then
    exec "$candidate" --disable-warning=ExperimentalWarning --experimental-ffi "$here/src/app.mjs" "$@"
  fi
done

echo "tv-remote-tui: need Node.js >= 26.4 (FFI). Found: $(node --version 2>/dev/null || echo 'no node')." >&2
echo "Set NODE_BIN=/path/to/node to override." >&2
exit 1
