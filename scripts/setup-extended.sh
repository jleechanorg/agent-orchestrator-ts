#!/bin/bash
# Agent Orchestrator — jleechanorg fork extended setup
# Installs fork-specific services: launchd lifecycle-workers, config validation, ao rebuild
#
# Called by setup.sh after the base setup completes.
# Can also be run standalone: bash scripts/setup-extended.sh

set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib/ao-config-topology.sh
source "$SCRIPT_DIR/lib/ao-config-topology.sh"
# Gate managed-topology validation only when using auto-discovered config.
# If AO_CONFIG_PATH is set explicitly, respect it without blocking on topology.
CONFIG_FILE="${AO_CONFIG_PATH:-$(ao_staging_config_path)}"
if [ -z "${AO_CONFIG_PATH:-}" ]; then
  ao_validate_topology
fi

if [ ! -f "$CONFIG_FILE" ]; then
  echo "WARNING: No config found at $CONFIG_FILE"
  echo "  Create one or set AO_CONFIG_PATH to your agent-orchestrator.yaml"
else
  echo "[ok] Config: $CONFIG_FILE"
fi

# Check for duplicate configs that would create split namespaces
STAGING_REAL="$(ao_realpath "$(ao_staging_config_path)")"
PRODUCTION_REAL="$(ao_realpath "$(ao_production_config_path)")"
DUPES=$(find "$HOME" -maxdepth 4 -name "agent-orchestrator.yaml" \
  -not -path "*/node_modules/*" \
  -not -path "*/.agent-orchestrator/*" \
  -not -path "*/Dropbox/*" \
  -not -path "*/.worktrees/*" \
  -not -path "*/worktrees/*" \
  -not -path "*/backup/*" \
  2>/dev/null | while read -r candidate; do
    resolved="$(ao_realpath "$candidate")"
    if [ "$resolved" != "$STAGING_REAL" ] && [ "$resolved" != "$PRODUCTION_REAL" ]; then
      printf '%s\n' "$candidate"
    fi
  done || true)

if [ -n "$DUPES" ]; then
  echo ""
  echo "WARNING: Found duplicate agent-orchestrator.yaml files (potential namespace split):"
  echo "$DUPES" | while read -r f; do echo "  $f"; done
  echo ""
  echo "  Only the managed staging/prod configs should exist. Others create separate data namespaces."
  echo "  Remove duplicates or they will cause sessions to be invisible to the lifecycle-worker."
fi

# ─── Rebuild ao CLI from source ─────────────────────────────────────────────

echo ""
echo "Rebuilding ao CLI from source..."
cd "$REPO_ROOT"
pnpm build 2>&1 | tail -1

echo "Linking ao CLI globally..."
cd "$REPO_ROOT/packages/cli"
# Try npm install -g first, then sudo fallback. This preserves the original
# behavior while still providing clear error output when both fail.
if ! npm install -g . 2>/dev/null; then
  if command -v sudo >/dev/null 2>&1; then
    sudo npm install -g .
  else
    echo "WARNING: npm install -g failed and sudo is unavailable." >&2
    echo "         Ao CLI may not be available in PATH." >&2
    # In CI (Docker), proceed anyway since the test may not need global CLI
    if [ "${CI:-}" != "true" ]; then
      exit 1
    fi
  fi
fi
cd "$REPO_ROOT"

AO_VERSION=$(ao --version 2>/dev/null || echo "unknown")
echo "[ok] ao $AO_VERSION installed"

# ─── Start all projects via ao start ────────────────────────────────────────

# Skip in CI environments — the onboarding test starts its own dashboard on
# a known port, and running ao start here would cause a port conflict.
if [ "${CI:-}" = "true" ]; then
  echo ""
  echo "Skipping 'ao start' in CI environment (onboarding test manages its own dashboard)."
else
  echo ""
  echo "Starting all projects..."

  START_ALL="$REPO_ROOT/scripts/start-all.sh"
  if [ -f "$START_ALL" ]; then
    AO_CONFIG_PATH="$CONFIG_FILE" bash "$START_ALL"
  else
    echo "  WARNING: scripts/start-all.sh not found. Run manually:"
    echo "    ao start <project-name>"
  fi

  # Keep service automation portable across machines: install launchd jobs from one
  # central script (lifecycle + novel). This is safe to rerun.
  if [ -x "$REPO_ROOT/scripts/setup-launchd.sh" ]; then
    echo ""
    echo "Installing launchd jobs from central installer..."
    AO_CONFIG_PATH="$CONFIG_FILE" bash "$REPO_ROOT/scripts/setup-launchd.sh" all
  else
    echo "  WARNING: scripts/setup-launchd.sh missing or not executable."
  fi
fi

# ─── Legacy launchd cleanup ─────────────────────────────────────────────────
# Remove old per-project lifecycle-worker plists (replaced by ao start)

PLIST_DIR="$HOME/Library/LaunchAgents"
for plist in "$PLIST_DIR"/com.agentorchestrator.lifecycle-*.plist; do
  [ -f "$plist" ] || continue
  label=$(basename "$plist" .plist)
  launchctl unload "$plist" 2>/dev/null
  rm -f "$plist"
  echo "  Removed legacy plist: $label"
done

# ─── Kill stale non-launchd lifecycle-workers per project ───────────────────
# Reads project IDs from config and verifies PID before sending signals.
# Uses word-boundary grep to prevent "api" from matching "api-v2".
if [ -f "$CONFIG_FILE" ] && [ -d "$HOME/.agent-orchestrator" ]; then
  PROJECTS="$(python3 - "$CONFIG_FILE" <<'PYEOF' 2>/dev/null || true
import sys
import yaml

try:
    with open(sys.argv[1]) as f:
        cfg = yaml.safe_load(f) or {}
    for pid in (cfg.get("projects") or {}):
        print(pid)
except:
    pass
PYEOF
)"
  if [ -n "$PROJECTS" ]; then
    # Compute namespace hash: sha256(realpath(dirname(configPath)))[:12]
    PID_FILE_NS="$(python3 -c "
import hashlib, os
try:
    cfg_path = os.path.realpath('$CONFIG_FILE')
    ns = hashlib.sha256(os.path.dirname(cfg_path).encode()).hexdigest()[:12]
    print(ns)
except:
    pass
" 2>/dev/null || echo "")"
    if [ -n "$PID_FILE_NS" ]; then
      for PROJECT in $PROJECTS; do
        # projectId = basename(project.path) — matches TypeScript generateProjectId()
        PROJ_ID_FOR_PID="$(python3 - "$CONFIG_FILE" "$PROJECT" <<'PYEOF' 2>/dev/null || echo ""
import sys
import os
import yaml

try:
    config_path = sys.argv[1]
    project_id = sys.argv[2]
    with open(config_path) as f:
        cfg = yaml.safe_load(f) or {}
    proj_cfg = (cfg.get("projects") or {}).get(project_id, {})
    project_path = proj_cfg.get("path", "") or ""
    if project_path:
        if project_path.startswith("~"):
            project_path = os.path.expanduser(project_path)
        elif not os.path.isabs(project_path):
            project_path = os.path.normpath(os.path.join(os.path.dirname(config_path), project_path))
        print(os.path.basename(project_path))
except:
    pass
PYEOF
)"
        PROJ_ID_FOR_PID="${PROJ_ID_FOR_PID:-$PROJECT}"
        LW_PID_FILE="$HOME/.agent-orchestrator/${PID_FILE_NS}-${PROJ_ID_FOR_PID}/lifecycle-worker.pid"
        if [ -f "$LW_PID_FILE" ]; then
          LW_PID="$(cat "$LW_PID_FILE" 2>/dev/null)"
          if [ -n "$LW_PID" ] && kill -0 "$LW_PID" 2>/dev/null; then
            # Verify: use word-boundary grep so "api" does not match "api-v2"
            if ps -p "$LW_PID" -o args= 2>/dev/null | grep -qE "\blifecycle-worker[[:space:]]+${PROJ_ID_FOR_PID}($|[[:space:]])"; then
              echo "  [kill] $PROJ_ID_FOR_PID lifecycle-worker PID $LW_PID"
              kill "$LW_PID" 2>/dev/null || true
            fi
          fi
        fi
      done
    fi
  fi
fi

# ─── Clean stale PID files ─────────────────────────────────────────────────
# Removes PID files whose PIDs are no longer running. Uses word-boundary
# grep so a project named "api" does not match processes for "api-v2".

echo ""
echo "Cleaning stale lifecycle-worker PID files..."
CLEANED=0
for pidfile in $(find "$HOME/.agent-orchestrator" -name "lifecycle-worker.pid" 2>/dev/null); do
  pid=$(cat "$pidfile" 2>/dev/null)
  if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then
    rm -f "$pidfile"
    CLEANED=$((CLEANED + 1))
  fi
done
echo "  Cleaned $CLEANED stale PID files"

# ─── GitHub Webhook Server ─────────────────────────────────────────────────
# The webhook server receives push/PR events from GitHub and triggers
# lifecycle checks without polling. Requires TailScale for public URL.
#
# Prerequisites:
#   - TailScale installed and authenticated: https://tailscale.com/download
#   - AO_GITHUB_WEBHOOK_SECRET generated and stored in .env.local
#   - GitHub webhooks registered for each repo (auto-done by ao webhook install)

WEBHOOK_ENV="$REPO_ROOT/packages/web/.env.local"
WEBHOOK_SECRET_VAR="AO_GITHUB_WEBHOOK_SECRET"
WEBHOOK_PORT="${AO_WEBHOOK_PORT:-3030}"

# Generate webhook secret if not present
if [ -f "$WEBHOOK_ENV" ]; then
  if ! grep -q "$WEBHOOK_SECRET_VAR" "$WEBHOOK_ENV" 2>/dev/null; then
    SECRET=$(python3 -c "import secrets; print(secrets.token_hex(32))")
    echo "$WEBHOOK_SECRET_VAR=$SECRET" >> "$WEBHOOK_ENV"
    echo "[ok] Generated $WEBHOOK_SECRET_VAR in packages/web/.env.local"
  else
    echo "[ok] $WEBHOOK_SECRET_VAR already present"
  fi
else
  SECRET=$(python3 -c "import secrets; print(secrets.token_hex(32))")
  echo "$WEBHOOK_SECRET_VAR=$SECRET" > "$WEBHOOK_ENV"
  echo "[ok] Created packages/web/.env.local with $WEBHOOK_SECRET_VAR"
fi

# TailScale Funnel: expose webhook port publicly (no firewall config needed)
if command -v tailscale &>/dev/null; then
  TS_STATUS=$(tailscale status --json 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('BackendState',''))" 2>/dev/null || echo "unknown")
  if [ "$TS_STATUS" = "Running" ]; then
    # Verify Funnel is open on the webhook port
    TS_FUNNEL=$(tailscale funnel status 2>/dev/null | grep -E "^${WEBHOOK_PORT}\b" | awk '{print $2}' || echo "off")
    if [ "$TS_FUNNEL" != "$WEBHOOK_PORT" ]; then
      echo "[tail] Opening TailScale Funnel on port $WEBHOOK_PORT..."
      # Reset and reconfigure funnel on webhook port only
      tailscale funnel --bg "$WEBHOOK_PORT" 2>/dev/null || \
        tailscale funnel reset 2>/dev/null && tailscale funnel --bg "$WEBHOOK_PORT" 2>/dev/null || \
        echo "  WARNING: Could not configure Funnel. Run manually: tailscale funnel --bg $WEBHOOK_PORT"
    fi
    FUNNEL_URL=$(tailscale funnel status 2>/dev/null | grep -E "^${WEBHOOK_PORT}" | awk '{print $3}' || echo "")
    if [ -n "$FUNNEL_URL" ]; then
      echo "[ok] TailScale Funnel active: $FUNNEL_URL"
    else
      echo "[ok] TailScale running (Funnel status: see 'tailscale funnel status')"
    fi
  else
    echo "[skip] TailScale not logged in (status: $TS_STATUS). Run 'tailscale login' to enable webhooks."
  fi
else
  echo "[skip] TailScale not installed. Install from https://tailscale.com/download to enable webhook server."
fi

# Check if webhook server is running on the port
WEBHOOK_PID=$(lsof -ti :"$WEBHOOK_PORT" 2>/dev/null | head -1 || true)
if [ -z "$WEBHOOK_PID" ]; then
  echo "[tail] Starting webhook server on port $WEBHOOK_PORT..."
  cd "$REPO_ROOT/packages/web"
  # Start next dev server in background, tagged so it can be found
  pnpm next dev --port "$WEBHOOK_PORT" >> ~/.agent-orchestrator/webhook-server.log 2>&1 &
  WEBHOOK_BG_PID=$!
  sleep 3
  if kill -0 "$WEBHOOK_BG_PID" 2>/dev/null; then
    echo "[ok] Webhook server started (PID $WEBHOOK_BG_PID) on port $WEBHOOK_PORT"
    echo "$WEBHOOK_BG_PID" > ~/.agent-orchestrator/webhook-server.pid
  else
    echo "  WARNING: Webhook server failed to start. Check ~/.agent-orchestrator/webhook-server.log"
  fi
else
  echo "[ok] Webhook server already running on port $WEBHOOK_PORT (PID $WEBHOOK_PID)"
fi

# Register GitHub webhooks for all configured repos
echo ""
echo "Registering GitHub webhooks for configured repos..."
CONFIG_FILE="${AO_CONFIG_PATH:-$(ao_staging_config_path)}"
if [ -f "$CONFIG_FILE" ]; then
  # Collect webhook URL from TailScale Funnel or use localhost
  if command -v tailscale &>/dev/null && [ "$(tailscale status --json 2>/dev/null | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("BackendState",""))' 2>/dev/null)" = "Running" ]; then
    WEBHOOK_BASE_URL=$(tailscale funnel status 2>/dev/null | grep -E "^${WEBHOOK_PORT}" | awk '{print $3}' | sed 's|/+$||' || echo "")
  fi
  WEBHOOK_BASE_URL="${WEBHOOK_BASE_URL:-http://localhost:${WEBHOOK_PORT}}"
  WEBHOOK_API_PATH="/api/webhooks/github"
  SECRET=$(python3 -c "import secrets; print(secrets.token_hex(32))" 2>/dev/null || echo "")

  # Read secret from .env.local if available
  if [ -f "$WEBHOOK_ENV" ]; then
    SECRET=$(grep "^$WEBHOOK_SECRET_VAR=" "$WEBHOOK_ENV" 2>/dev/null | cut -d= -f2 || echo "$SECRET")
  fi

  if [ -z "$SECRET" ] || [ "$SECRET" = "$WEBHOOK_SECRET_VAR" ]; then
    SECRET=$(python3 -c "import secrets; print(secrets.token_hex(32))")
  fi

  python3 - "$CONFIG_FILE" "$WEBHOOK_BASE_URL" "$WEBHOOK_API_PATH" "$SECRET" << 'PYEOF' 2>/dev/null || true
import sys, json, subprocess, urllib.request, urllib.error, os, hmac, hashlib

config_path, base_url, api_path, secret = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
full_url = f"{base_url}{api_path}"

try:
    import yaml
    with open(config_path) as f:
        cfg = yaml.safe_load(f) or {}
except:
    print("  WARNING: Could not parse config for webhook registration")
    sys.exit(0)

token = os.environ.get('GITHUB_TOKEN') or subprocess.check_output(['gh', 'auth', 'token']).strip().decode()

payload = json.dumps({
    'name': 'web',
    'active': True,
    'events': ['push', 'pull_request'],
    'config': {
        'url': full_url,
        'content_type': 'json',
        'secret': secret,
        'insecure_ssl': '0'
    }
}).encode()

headers = {
    'Authorization': 'Bearer ' + token,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
}

for project_id, proj_cfg in (cfg.get('projects') or {}).items():
    repo = proj_cfg.get('repo', '')
    scm_cfg = proj_cfg.get('scm', {})
    webhook_cfg = scm_cfg.get('webhook', {})
    if not repo:
        continue
    # Only register for repos that have scm.plugin: github
    if scm_cfg.get('plugin') != 'github':
        continue
    # Skip if webhook config is missing (server won't route these)
    if not webhook_cfg:
        continue
    # Skip if webhook already enabled in config (already handled)
    if webhook_cfg.get('enabled'):
        continue

    req = urllib.request.Request(
        f'https://api.github.com/repos/{repo}/hooks',
        data=payload,
        headers=headers,
        method='POST'
    )
    try:
        with urllib.request.urlopen(req) as resp:
            result = json.loads(resp.read())
            print(f"  ✓ {repo}: hook {result.get('id')}")
    except urllib.error.HTTPError as e:
        body = json.loads(e.read())
        msg = body.get('message', 'error')
        # 422 = already exists, 404 = repo not found
        print(f"  ~ {repo}: {e.code} {msg}")
    except Exception as e:
        print(f"  ~ {repo}: {e}")

PYEOF
else
  echo "  Skipping webhook registration (no config found)"
fi

# ─── Done ───────────────────────────────────────────────────────────────────

echo ""
echo "═══ Extended setup complete ═══"
echo ""
echo "Lifecycle workers are running. Monitor with:"
echo "  ao session ls"
echo "  tail -f ${HOME}/.openclaw/logs/ao-lifecycle-*.log"
