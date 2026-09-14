#!/bin/sh
# berth plugin launcher: find a Node 20+ interpreter even when the hook environment has no
# version-manager shims on PATH, then run the bundled CLI. Always exits 0 for hook subcommands
# so a missing interpreter or bundle can never fail a session; it says why on stderr.
set -u
root="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
bundle="$root/dist/berth.js"
sub="${1:-}"
is_hook=0
case "$sub" in context|session-end) is_hook=1 ;; esac
node_bin=""
if command -v node >/dev/null 2>&1; then
  node_bin="$(command -v node)"
else
  for c in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.local/share/mise/shims/node" "$HOME/.volta/bin/node" "$HOME/.fnm/aliases/default/bin/node" "$HOME/.asdf/shims/node"; do
    [ -x "$c" ] && { node_bin="$c"; break; }
  done
  if [ -z "$node_bin" ] && [ -d "$HOME/.nvm/versions/node" ]; then
    node_bin="$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1)"
  fi
fi
if [ -z "$node_bin" ]; then
  echo "berth: no node interpreter found for the plugin hook; install Node 20+ or add it to PATH" >&2
  [ "$is_hook" = 1 ] && exit 0
  exit 127
fi
if [ ! -f "$bundle" ]; then
  echo "berth: bundle missing at $bundle (plugin installed without a build?)" >&2
  [ "$is_hook" = 1 ] && exit 0
  exit 127
fi
# Tell the CLI where the plugin lives so `berth context` can put bin/ on the session PATH.
BERTH_PLUGIN_ROOT="$root"
export BERTH_PLUGIN_ROOT
exec "$node_bin" "$bundle" "$@"
