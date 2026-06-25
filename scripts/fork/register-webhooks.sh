#!/bin/bash
# scripts/fork/register-webhooks.sh — fork-specific opt-in script
#
# Purpose:
#   Register GitHub webhooks for all repos in the agent-orchestrator config
#   that have `scm.plugin: github`. Uses Tailscale Funnel for the public URL.
#
# This script is OPT-IN. setup.sh does NOT call it automatically.
# Run explicitly: `bash scripts/fork/register-webhooks.sh`
#
# Upstream alignment (vs. scripts/setup-extended.sh auto-registration):
#   - Upstream agentwrapper/agent-orchestrator does NOT auto-register webhooks.
#   - This script makes it an explicit operator decision, not a setup side-effect.
#   - Requires Tailscale running + Funnel on. No silent localhost fallback
#     (GitHub rejects http://localhost with 422 — confirmed in production).
#
# Prerequisites:
#   - Tailscale installed + authenticated + Funnel enabled on webhook port:
#       brew install tailscale
#       tailscale up
#       tailscale funnel --bg 3030
#   - AO_GITHUB_WEBHOOK_SECRET in packages/web/.env.local (auto-generated below)
#   - gh CLI authenticated (run `gh auth login` first)
#   - Next.js webhook server running on $WEBHOOK_PORT (start it separately)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/ao-config-topology.sh
source "$SCRIPT_DIR/../lib/ao-config-topology.sh"
# shellcheck source=../lib/pnpm-global-path.sh
source "$SCRIPT_DIR/../lib/pnpm-global-path.sh"

WEBHOOK_ENV="$REPO_ROOT/packages/web/.env.local"
WEBHOOK_SECRET_VAR="AO_GITHUB_WEBHOOK_SECRET"
WEBHOOK_PORT="${AO_WEBHOOK_PORT:-3030}"
WEBHOOK_API_PATH="/api/webhooks/github"

echo "=== register-webhooks.sh (fork opt-in) ==="
echo ""

# ─── 1. Generate webhook secret in .env.local ────────────────────────────────
if [ -f "$WEBHOOK_ENV" ]; then
  if ! grep -q "^$WEBHOOK_SECRET_VAR=" "$WEBHOOK_ENV" 2>/dev/null; then
    SECRET=$(python3 -c "import secrets; print(secrets.token_hex(32))")
    echo "$WEBHOOK_SECRET_VAR=$SECRET" >> "$WEBHOOK_ENV"
    echo "[ok] Generated $WEBHOOK_SECRET_VAR in packages/web/.env.local"
  else
    echo "[ok] $WEBHOOK_SECRET_VAR already present in .env.local"
  fi
else
  SECRET=$(python3 -c "import secrets; print(secrets.token_hex(32))")
  echo "$WEBHOOK_SECRET_VAR=$SECRET" > "$WEBHOOK_ENV"
  echo "[ok] Created packages/web/.env.local with $WEBHOOK_SECRET_VAR"
fi

# ─── 2. Determine the public webhook URL via Tailscale Funnel ─────────────────
# NO localhost fallback — GitHub rejects http://localhost with 422.
# Fail loudly if Tailscale isn't running so the operator fixes the chain.
if ! command -v tailscale >/dev/null 2>&1; then
  echo "ERROR: tailscale is not installed."
  echo "  Install: https://tailscale.com/download"
  echo "  Then:    tailscale up && tailscale funnel --bg $WEBHOOK_PORT"
  exit 1
fi

TS_STATUS=$(tailscale status --json 2>/dev/null | \
  python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('BackendState',''))" 2>/dev/null \
  || echo "unknown")
if [ "$TS_STATUS" != "Running" ]; then
  echo "ERROR: Tailscale is installed but not logged in (status: $TS_STATUS)."
  echo "  Run: tailscale up"
  exit 1
fi

# Parse the Funnel URL for port $WEBHOOK_PORT.
# Tailscale's `funnel status` output is URL-led (e.g.
#   https://host.tailnet.ts.net/
#   |--> https://host.tailnet.ts.net:443 (Funnel on)
#   |    --> "https://host.tailnet.ts.net:3030" (Funnel on)
# ), not port-led, so we grep for the JSON serve-config instead and
# extract the Funnel host:port mapping. Falls back to human-readable parsing
# if the JSON is unavailable.
FUNNEL_URL=""
SERVE_JSON=$(tailscale status --json 2>/dev/null || true)
if [ -n "$SERVE_JSON" ]; then
  # Funnel exposes TCP via `PeerAPI`; the ServeConfig holds the port-to-URL map.
  # tailscale status --json includes `CertDomains[0]` which is the Tailnet hostname.
  # The Funnel URL is https://${CertDomains[0]}:${WEBHOOK_PORT}
  HOSTNAME=$(printf '%s' "$SERVE_JSON" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print((d.get('CertDomains') or [''])[0])" 2>/dev/null \
    || true)
  if [ -n "$HOSTNAME" ]; then
    FUNNEL_URL="https://${HOSTNAME}:${WEBHOOK_PORT}"
  fi
fi

if [ -z "$FUNNEL_URL" ]; then
  echo "ERROR: Tailscale is running but Funnel is not open on port $WEBHOOK_PORT."
  echo "  Run: tailscale funnel --bg $WEBHOOK_PORT"
  exit 1
fi

PUBLIC_URL="${FUNNEL_URL}${WEBHOOK_API_PATH}"
echo "[ok] Public webhook URL: $PUBLIC_URL"

# ─── 3. Resolve the agent-orchestrator config ────────────────────────────────
CONFIG_FILE="${AO_CONFIG_PATH:-$(ao_staging_config_path)}"
if [ ! -f "$CONFIG_FILE" ]; then
  echo "ERROR: No agent-orchestrator config at $CONFIG_FILE"
  echo "  Run 'ao start' first to create one, or set AO_CONFIG_PATH=..."
  exit 1
fi
echo "[ok] Using config: $CONFIG_FILE"

# Read the secret we just wrote
SECRET=$(grep "^$WEBHOOK_SECRET_VAR=" "$WEBHOOK_ENV" 2>/dev/null | cut -d= -f2 || true)
if [ -z "$SECRET" ] || [ "$SECRET" = "$WEBHOOK_SECRET_VAR" ]; then
  echo "ERROR: $WEBHOOK_SECRET_VAR is empty in $WEBHOOK_ENV"
  exit 1
fi

# ─── 4. Register webhooks for every github-scm project ───────────────────────
# Pass args via argv (NOT interpolation) to avoid shell-quoting injection.
# See memory: feedback_2026-06-23_python_c_string_interp_injection
python3 - "$CONFIG_FILE" "$PUBLIC_URL" "$SECRET" << 'PYEOF'
import sys, json, subprocess, urllib.request, urllib.error, os

config_path, public_url, secret = sys.argv[1], sys.argv[2], sys.argv[3]

try:
    import yaml
    with open(config_path) as f:
        cfg = yaml.safe_load(f) or {}
except Exception as e:
    print(f"ERROR: Could not parse {config_path}: {e}")
    sys.exit(1)

token = os.environ.get('GITHUB_TOKEN')
if not token:
    try:
        token = subprocess.check_output(['gh', 'auth', 'token'], stderr=subprocess.DEVNULL).strip().decode()
    except Exception:
        print("ERROR: GITHUB_TOKEN unset and 'gh auth token' failed.")
        print("  Run: gh auth login")
        sys.exit(1)

payload = json.dumps({
    'name': 'web',
    'active': True,
    'events': ['push', 'pull_request'],
    'config': {
        'url': public_url,
        'content_type': 'json',
        'secret': secret,
        'insecure_ssl': '0',
    },
}).encode()

headers = {
    'Authorization': 'Bearer ' + token,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
}

registered = 0
skipped_307 = 0
already_exists = 0
errors = 0

for project_id, proj_cfg in (cfg.get('projects') or {}).items():
    repo = proj_cfg.get('repo', '')
    scm_cfg = proj_cfg.get('scm', {})
    webhook_cfg = scm_cfg.get('webhook', {})

    if not repo:
        continue
    if webhook_cfg.get('enabled'):
        print(f"  ✓ {repo}: webhook config-driven (skipping auto-register)")
        skipped_307 += 1
        continue
    if scm_cfg.get('plugin') != 'github':
        continue  # not a github-scm project

    req = urllib.request.Request(
        f'https://api.github.com/repos/{repo}/hooks',
        data=payload,
        headers=headers,
        method='POST',
    )
    try:
        with urllib.request.urlopen(req) as resp:
            result = json.loads(resp.read())
            hook_id = result.get('id')
            print(f"  ✓ {repo}: hook {hook_id} registered")
            registered += 1
    except urllib.error.HTTPError as e:
        body_text = e.read().decode(errors='replace')
        try:
            body = json.loads(body_text)
        except Exception:
            body = {'message': body_text[:200]}
        # GitHub wraps the actual reason in `errors[].message`. The top-level
        # `message` is usually just "Validation Failed" for 422s, so check both.
        msg = body.get('message', 'unknown error')
        errs = body.get('errors') or []
        detail_msgs = [str(err.get('message', '')) for err in errs if isinstance(err, dict)]
        combined_msg = (msg + ' ' + ' '.join(detail_msgs)).lower()

        if e.code == 422 and 'already exists' in combined_msg:
            print(f"  ~ {repo}: already exists (skipping)")
            already_exists += 1
        elif e.code == 404:
            # Fork or archived repo without admin perms — silently skip.
            print(f"  ~ {repo}: 404 not found (skipping — likely no admin access)")
            skipped_307 += 1
        elif e.code in (301, 302, 307, 308):
            # Repo was renamed/moved; not a fatal error.
            new_url = e.headers.get('Location', 'unknown')
            print(f"  ~ {repo}: redirect ({e.code}) → {new_url} (skipping)")
            skipped_307 += 1
        else:
            print(f"  ✗ {repo}: HTTP {e.code} {msg}")
            errors += 1
    except Exception as e:
        print(f"  ✗ {repo}: {type(e).__name__}: {e}")
        errors += 1

print()
print(f"Summary: {registered} registered, {already_exists} already-existed, "
      f"{skipped_307} skipped (config-driven / 404 / redirect), {errors} errors")
sys.exit(0 if errors == 0 else 1)
PYEOF

echo ""
echo "=== register-webhooks.sh complete ==="
