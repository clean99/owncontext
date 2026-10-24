#!/usr/bin/env bash
set -euo pipefail

task_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
task_node="$(command -v node || true)"
if [[ -z "$task_node" ]] || ! "$task_node" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)'; then
  for task_candidate in "$HOME"/.nvm/versions/node/v24*/bin/node; do
    if [[ -x "$task_candidate" ]]; then task_node="$task_candidate"; fi
  done
fi
if [[ -z "$task_node" ]] || ! "$task_node" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)'; then
  echo 'Please install Node 24 LTS before running Wrangler.' >&2
  exit 1
fi
cd "$task_root"
export PATH="$(dirname "$task_node"):$PATH"
exec "$task_node" node_modules/wrangler/bin/wrangler.js "$@"
