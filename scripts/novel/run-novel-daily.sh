#!/usr/bin/env bash
# run-novel-daily.sh — called by ai.agento.novel-daily launchd agent
# Installs via: ln -sf "$(pwd)/launchd/ai.agento.novel-daily.plist" ~/Library/LaunchAgents/
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_FILE="${REPO_ROOT}/logs/novel-daily.log"

mkdir -p "$(dirname "$LOG_FILE")"

exec node \
  "${REPO_ROOT}/scripts/novel/generate-daily-entry.mjs" \
  --days 1 \
  --file novel/the-daily-lives-of-workers.md \
  >> "$LOG_FILE" 2>&1
