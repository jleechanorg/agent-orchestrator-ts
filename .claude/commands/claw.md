---
description: /claw - Send a task to ao spawn (parallel tmux) for coding, gateway HTTP for read-only
type: orchestration
execution_mode: immediate
---
# /claw - OpenClaw Agent Dispatch (Parallel AO Sessions for Coding)

**Usage**: `/claw <task description>`

**Purpose**: Routes to the right execution path:
- **Coding tasks** (fix, implement, write code, create PR, update code, etc.) → `ao spawn` + `ao send` for parallel tmux sessions
- **Non-coding tasks** (summarize, read-only, explain, etc.) → OpenClaw gateway HTTP (existing behavior)

This replaces sequential single-agent processing with parallel multi-session execution.

## ⚠️ OPENCLAW AGENT — MANDATORY ROUTING RULE (orch-nkg)

If you are the **OpenClaw embedded agent** receiving this task from the gateway:

**DO NOT run this task inline.** Inline execution has no worktree, no PR, no branch.

**INSTEAD — follow the `dispatch-task` skill** (in this repo: `.claude/skills/dispatch-task/SKILL.md`):
1. Create/claim a bead (`br create ...` or `br update ... --status in_progress`; see CLAUDE.md for `br` examples)
2. Determine the ao project ID: `ao projects list`
3. Spawn: `ao spawn ORCH-xxx -p <project-id>`
4. Send: write task to tmp file, `ao send <session-name> --file <file>`

This applies to ALL tasks involving code, files, or PRs — see SOUL.md "Agent Dispatch Policy."

**How this interacts with Path A / Path B below:** Path A already runs `ao spawn` from this shell for classified **coding** tasks. This rule still applies when coding work reaches you through **Path B** (gateway HTTP), a misclassified task, or any non-`/claw` gateway traffic—use `dispatch-task` instead of executing inline.

## Execution Instructions

When this command is invoked with `$ARGUMENTS`:

### Step 0: Parse task

```bash
TASK_DESCRIPTION="$ARGUMENTS"
```

### Step 1: Classify task type

Use your judgment to classify the task as **coding** or **read_only**:
- **coding**: involves writing/modifying/fixing/creating code, PRs, tests, config, or deploys; working on a bead/issue that requires code changes; contains `ao spawn` or dispatch instructions; references a bead ID (e.g. `orch-sq2`, `wa-123`, `bd-cx01`)
- **read_only**: summarize, explain, analyze, check status, read-only queries — no code changes needed

When in doubt, classify as **coding** (err toward spawning a session).

```bash
TASK_TYPE="coding"  # Set to "read_only" only if you judged it non-coding above
echo "Task classified as: $TASK_TYPE"
```

### Step 2: Route

#### Path A — Coding Tasks: ao spawn (parallel)

```bash
if [ "$TASK_TYPE" = "coding" ]; then
  echo "=== PATH A: ao spawn (parallel coding sessions) ==="

  # Step A1: Extract issue ID from task (e.g. "orch-sq2", "ORCH-sq2", "bd-cx01", "fix bd-cx01")
  # Scan the task description for a bead/issue ID — pattern: prefix-alphanumeric
  # Valid prefixes: orch, wa, ao, ra, cc, wc, mt, mm, bd (this repo uses br beads: bd-*)
  # Use your judgment to identify the ID (case-insensitive). Set empty if none found.
  ISSUE_ID=""  # e.g. "bd-cx01" — extracted by you from TASK_DESCRIPTION, lowercase, or empty

  # Step A2: Resolve project from issue ID prefix or default to jleechanclaw
  case "$ISSUE_ID" in
    orch-*) PROJECT_ID="jleechanclaw" ;;
    bd-*)   PROJECT_ID="agent-orchestrator" ;;  # br beads in this fork map to AO project
    wa-*)   PROJECT_ID="worldarchitect" ;;
    ao-*)   PROJECT_ID="agent-orchestrator" ;;
    ra-*)   PROJECT_ID="ralph" ;;
    cc-*)   PROJECT_ID="claude-commands" ;;
    wc-*)   PROJECT_ID="worldai-claw" ;;
    mt-*)   PROJECT_ID="mctrl-test" ;;
    mm-*)   PROJECT_ID="mcp-mail" ;;
    *)      PROJECT_ID="jleechanclaw" ;;
  esac
  echo "Project: $PROJECT_ID  Issue: ${ISSUE_ID:-<none — will be created>}"

  # Step A2.5: Detect runtime override
  # If the task mentions "antig" or "antigravity", set RUNTIME_FLAG to "--runtime antigravity".
  # Use your judgment — no subprocess needed.
  RUNTIME_FLAG=""  # set to "--runtime antigravity" if task mentions antig/antigravity

  # Step A3: Verify ao is available
  if ! command -v ao &>/dev/null; then
    echo "ERROR: 'ao' command not found. Is agent-orchestrator installed?"
    echo "Install: npm install -g @agent-orchestrator/core  (or pip install agent-orchestrator)"
    exit 1
  fi

  # Step A4: Verify ao is configured (common locations; ao may still use defaults)
  AO_CONFIG=""
  for _cand in "$HOME/agent-orchestrator.yaml" "$HOME/project_jleechanclaw/jleechanclaw/agent-orchestrator.yaml" "./agent-orchestrator.yaml"; do
    if [ -f "$_cand" ]; then
      AO_CONFIG="$_cand"
      break
    fi
  done
  if [ -z "$AO_CONFIG" ]; then
    echo "WARNING: agent-orchestrator.yaml not found in usual paths — ao spawn may still work if ao is configured elsewhere"
  fi

  # Step A5: Resolve slash commands (same as original /claw)
  # (inline the slash command resolution from Step 2.5 of the original)
  TASK_WITH_RESOLVED_COMMANDS="$TASK_DESCRIPTION"

  SLASH_CMD=$(printf '%s' "$TASK_DESCRIPTION" | python3 -c "
import sys, re
text = sys.stdin.read().strip()
clean = re.sub(r'https?://\S+', '', text)
m = re.search(r'(?:^|\s)/([\w-]+)', clean)
if m:
    print(m.group(1))
" 2>/dev/null)

  if [ -n "$SLASH_CMD" ]; then
    RESOLVED_CONTENT=""
    RESOLVED_SOURCE=""
    for search_dir in ".claude/commands" "$HOME/.claude/commands"; do
      if [ -f "$search_dir/$SLASH_CMD.md" ]; then
        RESOLVED_CONTENT=$(cat "$search_dir/$SLASH_CMD.md" 2>/dev/null)
        RESOLVED_SOURCE="$search_dir/$SLASH_CMD.md"
        break
      fi
    done
    if [ -z "$RESOLVED_CONTENT" ]; then
      for search_dir in ".claude/skills" "$HOME/.claude/skills"; do
        if [ -f "$search_dir/$SLASH_CMD/SKILL.md" ]; then
          RESOLVED_CONTENT=$(cat "$search_dir/$SLASH_CMD/SKILL.md" 2>/dev/null)
          RESOLVED_SOURCE="$search_dir/$SLASH_CMD/SKILL.md"
          break
        elif [ -f "$search_dir/$SLASH_CMD.md" ]; then
          RESOLVED_CONTENT=$(cat "$search_dir/$SLASH_CMD.md" 2>/dev/null)
          RESOLVED_SOURCE="$search_dir/$SLASH_CMD.md"
          break
        fi
      done
    fi
    if [ -n "$RESOLVED_CONTENT" ]; then
      echo "Resolved /$SLASH_CMD from $RESOLVED_SOURCE"
      TASK_WITH_RESOLVED_COMMANDS="The user asked: $TASK_DESCRIPTION

Below is the full definition of /$SLASH_CMD (resolved from $RESOLVED_SOURCE). Execute it as instructed:

---
$RESOLVED_CONTENT
---"
    fi
  fi

  # Step A5.5: Learning-loop gate (fail-closed — always append unless explicitly present)
  # Does TASK_WITH_RESOLVED_COMMANDS already contain /learn, /integrate, or an explicit
  # note that learning is not applicable (e.g. "learning N/A", "skip /learn")?
  # Use your judgment directly — no subprocess needed. If any of those are present, skip.
  # If NOT present (including if you are unsure), append the /learn instruction below.
  # FAIL-CLOSED: omission = append. Only skip when you are confident /learn is covered.
  TASK_WITH_RESOLVED_COMMANDS="${TASK_WITH_RESOLVED_COMMANDS}

After completing all work and creating the PR, run /learn to capture any reusable patterns."
  # (Remove the appended /learn line above only if you judged the task already includes it)

  # Step A6: Write task to temp file for ao send
  mkdir -p /tmp/openclaw
  chmod 700 /tmp/openclaw 2>/dev/null || true
  TASK_FILE="$(mktemp /tmp/openclaw/.claw-task-XXXXXXXX)" || true
  if [ -z "$TASK_FILE" ] || [ ! -f "$TASK_FILE" ]; then
    echo "ERROR: mktemp failed for task file under /tmp/openclaw"
    exit 1
  fi
  chmod 600 "$TASK_FILE" 2>/dev/null || true
  if ! printf '%s' "$TASK_WITH_RESOLVED_COMMANDS" > "$TASK_FILE"; then
    echo "ERROR: could not write task file $TASK_FILE"
    rm -f "$TASK_FILE"
    exit 1
  fi

  # Step A7: Spawn ao session
  echo ""
  echo "Spawning ao session..."
  echo "  Issue: ${ISSUE_ID:-auto}"
  echo "  Project: $PROJECT_ID"

  # Capture ao spawn output; PIPESTATUS[0] is ao spawn exit (bash), not tee
  SPAWN_OUTPUT_FILE="$(mktemp /tmp/openclaw/.claw-spawn-XXXXXXXX)" || true
  if [ -z "$SPAWN_OUTPUT_FILE" ] || [ ! -f "$SPAWN_OUTPUT_FILE" ]; then
    echo "ERROR: mktemp failed for spawn log file"
    rm -f "$TASK_FILE"
    exit 1
  fi
  chmod 600 "$SPAWN_OUTPUT_FILE" 2>/dev/null || true

  if [ -n "$ISSUE_ID" ]; then
    # Spawn for existing issue
    ao spawn "$ISSUE_ID" -p "$PROJECT_ID" $RUNTIME_FLAG 2>&1 | tee "$SPAWN_OUTPUT_FILE"
    SPAWN_EXIT="${PIPESTATUS[0]}"
  else
    # No issue ID — create a bead first, then spawn
    echo "No issue ID detected — creating a bead..."
    BEAD_TITLE=$(printf '%s' "$TASK_DESCRIPTION" | cut -c1-80)
    BEAD_OUTPUT=$(br create "$BEAD_TITLE" --type task --priority 2 2>&1)
    echo "Bead creation: $BEAD_OUTPUT"
    # br emits ids like bd-xxxxx; also accept orch-* for harness compatibility
    ISSUE_ID=$(echo "$BEAD_OUTPUT" | python3 -c "import sys,re; t=sys.stdin.read(); m=re.search(r'\b((?:bd|orch)-[a-z0-9]+)\b', t, re.I); print(m.group(1).lower() if m else '')" 2>/dev/null)
    if [ -z "$ISSUE_ID" ]; then
      echo "ERROR: Failed to create bead from task"
      rm -f "$TASK_FILE" "$SPAWN_OUTPUT_FILE"
      exit 1
    fi
    echo "Created bead: $ISSUE_ID"
    ao spawn "$ISSUE_ID" -p "$PROJECT_ID" $RUNTIME_FLAG 2>&1 | tee "$SPAWN_OUTPUT_FILE"
    SPAWN_EXIT="${PIPESTATUS[0]}"
  fi

  if [ "${SPAWN_EXIT:-1}" -ne 0 ]; then
    echo "ERROR: ao spawn failed with exit code ${SPAWN_EXIT}"
    echo "--- spawn output (head) ---"
    head -40 "$SPAWN_OUTPUT_FILE" 2>/dev/null || true
    rm -f "$TASK_FILE" "$SPAWN_OUTPUT_FILE"
    exit 1
  fi

  # Step A8: Session name — SESSION= from spawn log, then ao status JSON, then ao session ls
  SESSION_NAME=""
  SESSION_NAME=$(grep -E '^SESSION=' "$SPAWN_OUTPUT_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\r' || true)
  if [ -z "$SESSION_NAME" ] && [ -n "$ISSUE_ID" ]; then
    SESSION_NAME=$(ao status --json --project "$PROJECT_ID" 2>/dev/null | ISSUE_ID="$ISSUE_ID" python3 -c 'import json, os, sys
want = os.environ.get("ISSUE_ID", "").lower().strip()
try:
    raw = sys.stdin.read()
    if not raw.strip():
        sys.exit(0)
    data = json.loads(raw)
    if isinstance(data, dict) and "sessions" in data:
        data = data["sessions"]
    if not isinstance(data, list):
        data = [data]
    for s in reversed(data):
        if not isinstance(s, dict):
            continue
        if str(s.get("issue", "")).lower() == want:
            n = s.get("name")
            if n:
                print(n)
            break
except Exception:
    pass
' 2>/dev/null || true)
  fi
  if [ -z "$SESSION_NAME" ]; then
    # DO NOT guess via tail -1 — in parallel mode this matches unrelated sessions.
    # Leave SESSION_NAME empty; the warning below will prompt manual recovery.
    echo "WARNING: Could not identify session name from spawn log or ao status"
  fi

  echo ""
  echo "Session name: ${SESSION_NAME:-<detecting...>}"
  echo "Task file: $TASK_FILE"

  # Step A9: Send task to session via file
  # NOTE: do NOT use --no-wait. ao send --no-wait queues the message in the Claude Code
  # REPL's "Press up to edit queued messages" buffer but does NOT submit it — the session
  # waits for a manual Enter. Without --no-wait, ao send blocks until the message is
  # actually submitted and the session starts processing.
  if [ -n "$SESSION_NAME" ]; then
    echo ""
    echo "Sending task to session $SESSION_NAME..."
    ao send "$SESSION_NAME" --file "$TASK_FILE" 2>&1
    SEND_EXIT=$?
    if [ $SEND_EXIT -eq 0 ]; then
      echo "Task sent successfully to $SESSION_NAME"
      # Verify delivery: peek at tmux to confirm session is actively processing (not idle)
      sleep 5
      TMUX_PANE_OUTPUT=$(tmux capture-pane -t "bb5e6b7f8db3-${SESSION_NAME}" -p -S -5 2>/dev/null | tail -5)
      if echo "$TMUX_PANE_OUTPUT" | grep -qE "Press up to edit|queued messages"; then
        echo "WARNING: task appears queued but not submitted — sending Enter to trigger"
        tmux send-keys -t "bb5e6b7f8db3-${SESSION_NAME}" "" Enter 2>/dev/null || true
        sleep 3
      fi
    else
      echo "WARNING: ao send exited with code $SEND_EXIT"
    fi
  else
    echo "WARNING: Could not detect session name — task may not be delivered"
    echo "To send manually: ao send <session> --file $TASK_FILE"
  fi

  # Step A10: Report to user
  echo ""
  echo "============================================"
  echo "  ao session spawned: ${SESSION_NAME:-unknown}"
  echo "  Project: $PROJECT_ID"
  echo "  Issue: ${ISSUE_ID:-auto-created bead}"
  echo "============================================"
  echo ""
  if [ -n "$SESSION_NAME" ]; then
    echo "  Attach: ao session attach $SESSION_NAME"
    echo "  Send more: ao send $SESSION_NAME '<message>'"
    echo "  Status: ao status"
  fi
  echo ""
  echo "Task dispatched in parallel — multiple PRs can be worked on simultaneously."
  echo "Note: multiple /claw invocations now run in parallel, not sequentially."

  # Clean up temp files (keep task file for manual send if needed)
  rm -f "$SPAWN_OUTPUT_FILE"

  # Step A11: Delivery tracking — verify session produces output
  # Write a tracking marker so the calling agent can verify delivery later
  TRACKING_FILE="/tmp/openclaw/.claw-track-${ISSUE_ID:-unknown}"
  cat > "$TRACKING_FILE" <<TRACK_EOF
ISSUE_ID=${ISSUE_ID:-unknown}
SESSION_NAME=${SESSION_NAME:-unknown}
PROJECT_ID=$PROJECT_ID
SPAWNED_AT=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
TASK_FILE=$TASK_FILE
STATUS=spawned
TRACK_EOF
  chmod 600 "$TRACKING_FILE" 2>/dev/null || true

  echo ""
  echo "Tracking: $TRACKING_FILE"
  echo ""
  echo "IMPORTANT: Verify delivery before reporting done:"
  echo "  1. tmux has-session -t bb5e6b7f8db3-${SESSION_NAME} 2>/dev/null  # session alive?"
  echo "  2. gh pr list -R <repo> --search '${ISSUE_ID}' --json number     # PR created?"
  echo "  If session died with no PR: respawn immediately or flag to user."

  exit 0
fi
```

#### Path B — Non-Coding Tasks: Gateway HTTP (original behavior)

```bash
# === PATH B: Gateway HTTP (read-only / summarize tasks) ===
echo "=== PATH B: Gateway HTTP (non-coding tasks) ==="

# Verify gateway is running
if ! lsof -i :18789 2>/dev/null | grep -q LISTEN; then
  echo "Gateway not running on port 18789. Start it with: launchctl start gui/$UID/ai.openclaw.gateway"
  exit 1
fi

# Read Gateway Token
GATEWAY_TOKEN=$(python3 -c "import json; d=json.load(open('$HOME/.openclaw/openclaw.json')); print(d['gateway']['auth']['token'])" 2>/dev/null)
if [ -z "$GATEWAY_TOKEN" ]; then
  echo "Could not read gateway token from ~/.openclaw/openclaw.json"
  exit 1
fi

# Resolve slash commands (same resolution as Path A)
TASK_WITH_RESOLVED="$TASK_DESCRIPTION"

SLASH_CMD=$(printf '%s' "$TASK_DESCRIPTION" | python3 -c "
import sys, re
text = sys.stdin.read().strip()
clean = re.sub(r'https?://\S+', '', text)
m = re.search(r'(?:^|\s)/([\w-]+)', clean)
if m:
    print(m.group(1))
" 2>/dev/null)

if [ -n "$SLASH_CMD" ]; then
  RESOLVED_CONTENT=""
  RESOLVED_SOURCE=""
  for search_dir in ".claude/commands" "$HOME/.claude/commands"; do
    if [ -f "$search_dir/$SLASH_CMD.md" ]; then
      RESOLVED_CONTENT=$(cat "$search_dir/$SLASH_CMD.md" 2>/dev/null)
      RESOLVED_SOURCE="$search_dir/$SLASH_CMD.md"
      break
    fi
  done
  if [ -z "$RESOLVED_CONTENT" ]; then
    for search_dir in ".claude/skills" "$HOME/.claude/skills"; do
      if [ -f "$search_dir/$SLASH_CMD/SKILL.md" ]; then
        RESOLVED_CONTENT=$(cat "$search_dir/$SLASH_CMD/SKILL.md" 2>/dev/null)
        RESOLVED_SOURCE="$search_dir/$SLASH_CMD/SKILL.md"
        break
      elif [ -f "$search_dir/$SLASH_CMD.md" ]; then
        RESOLVED_CONTENT=$(cat "$search_dir/$SLASH_CMD.md" 2>/dev/null)
        RESOLVED_SOURCE="$search_dir/$SLASH_CMD.md"
        break
      fi
    done
  fi
  if [ -n "$RESOLVED_CONTENT" ]; then
    echo "Resolved /$SLASH_CMD from $RESOLVED_SOURCE"
    TASK_WITH_RESOLVED="The user asked: $TASK_DESCRIPTION

Below is the full definition of /$SLASH_CMD (resolved from $RESOLVED_SOURCE). Execute it as instructed:

---
$RESOLVED_CONTENT
---"
  fi
fi

# Build JSON payload
LOGFILE="/tmp/openclaw/claw-$(date +%s).log"
mkdir -p /tmp/openclaw
chmod 700 /tmp/openclaw 2>/dev/null || true
PAYLOAD_FILE="$(mktemp /tmp/openclaw/.claw-payload-XXXXXXXX)"
chmod 600 "$PAYLOAD_FILE" 2>/dev/null || true

python3 -c "
import json, sys
payload = {
    'model': 'openclaw',
    'stream': True,
    'messages': [{'role': 'user', 'content': sys.argv[1]}]
}
with open(sys.argv[2], 'w') as f:
    json.dump(payload, f)
" "$TASK_WITH_RESOLVED" "$PAYLOAD_FILE"
py_rc=$?

if [ $py_rc -ne 0 ] || [ ! -s "$PAYLOAD_FILE" ]; then
  echo "Failed to build JSON payload"
  rm -f "$PAYLOAD_FILE"
  exit 1
fi

# Dispatch async
TOKEN_FILE="$(mktemp /tmp/openclaw/.claw-token-XXXXXXXX)"
chmod 600 "$TOKEN_FILE" 2>/dev/null || true
printf '%s' "$GATEWAY_TOKEN" > "$TOKEN_FILE"
unset GATEWAY_TOKEN

# Pass paths into nohup child (inner bash -c does not inherit unexported parent vars reliably)
PAYLOAD_FILE="$PAYLOAD_FILE" LOGFILE="$LOGFILE" TOKEN_FILE="$TOKEN_FILE" nohup bash -c '
GATEWAY_TOKEN=$(cat "$TOKEN_FILE" 2>/dev/null)
rm -f "$TOKEN_FILE"
if [ -z "$GATEWAY_TOKEN" ]; then echo "TOKEN ERROR"; exit 1; fi

RAW_BODY_FILE="$(mktemp /tmp/openclaw/.claw-body-XXXXXXXX)"
HTTP_META_FILE="$(mktemp /tmp/openclaw/.claw-http-XXXXXXXX)"

curl -sS -N \
  http://127.0.0.1:18789/v1/chat/completions \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -H "x-openclaw-agent-id: main" \
  --max-time 600 \
  -d @"$PAYLOAD_FILE" \
  -o "$RAW_BODY_FILE" \
  -w "%{http_code}" >"$HTTP_META_FILE" 2>/dev/null

CURL_EXIT=$?
if [ $CURL_EXIT -ne 0 ]; then
  echo "CURL ERROR: request failed with exit code $CURL_EXIT"
  rm -f "$PAYLOAD_FILE" "$RAW_BODY_FILE" "$HTTP_META_FILE"
  unset GATEWAY_TOKEN
  exit 1
fi

rm -f "$PAYLOAD_FILE"
unset GATEWAY_TOKEN

HTTP_CODE=$(cat "$HTTP_META_FILE" 2>/dev/null || echo "")

ERROR_MSG=$(head -1 "$RAW_BODY_FILE" 2>/dev/null | python3 -c "
import sys, json
try:
    d = json.loads(sys.stdin.read())
    if \"error\" in d:
        err = d[\"error\"]
        if isinstance(err, dict):
            print(err.get(\"message\", str(err)))
        else:
            print(str(err))
except Exception:
    pass
" 2>/dev/null)

if [ -n "$ERROR_MSG" ]; then
  echo "GATEWAY ERROR (HTTP $HTTP_CODE): $ERROR_MSG"
elif [[ -n "$HTTP_CODE" && "$HTTP_CODE" =~ ^[4-5][0-9][0-9]$ ]]; then
  echo "GATEWAY ERROR: HTTP $HTTP_CODE"
  head -5 "$RAW_BODY_FILE" 2>/dev/null
else
  python3 - "$RAW_BODY_FILE" <<SSEOF
import json, sys
buf = []
with open(sys.argv[1], "r", errors="replace") as f:
    for raw in f:
        line = raw.rstrip("\n")
        if line == "":
            if buf:
                payload = "\n".join(buf)
                buf = []
                if payload.strip() == "[DONE]":
                    continue
                try:
                    d = json.loads(payload)
                    delta = d["choices"][0].get("delta", {})
                    if "content" in delta:
                        print(delta["content"], end="", flush=True)
                except Exception:
                    pass
            continue
        if line.startswith("data:"):
            buf.append(line[5:].lstrip())
    if buf:
        payload = "\n".join(buf)
        if payload.strip() != "[DONE]":
            try:
                d = json.loads(payload)
                delta = d["choices"][0].get("delta", {})
                if "content" in delta:
                    print(delta["content"], end="", flush=True)
            except Exception:
                pass
SSEOF
fi
rm -f "$HTTP_META_FILE" "$RAW_BODY_FILE"
echo ""
echo "--- claw task completed $(date) ---"
' > "$LOGFILE" 2>&1 &

CLAW_PID=$!
echo "Task dispatched async to OpenClaw gateway"
echo "PID: $CLAW_PID"
echo "Log: $LOGFILE"
echo ""
echo "Monitor: tail -f $LOGFILE"
echo "Kill: kill $CLAW_PID"
```

## Task Classification Reference

| Pattern | Route |
|---------|-------|
| Contains `fix`, `implement`, `write code`, `create PR`, `refactor` | **ao spawn** (Path A) |
| Contains issue ID like `orch-xxxx`, `wa-xxxx`, `bd-xxxx` | **ao spawn** (Path A) |
| Contains PR reference like `PR #123` | **ao spawn** (Path A) |
| Contains `summarize`, `explain`, `read-only`, `what is`, `list` | **Gateway HTTP** (Path B) |
| No coding keywords detected | **Gateway HTTP** (Path B) |

## Requirements

- **ao spawn path**: `ao` CLI installed, `agent-orchestrator.yaml` configured, `br` CLI for bead creation
- **Gateway HTTP path**: OpenClaw gateway running on port 18789, auth token in `~/.openclaw/openclaw.json`

## Notes

- **Parallelism**: Multiple `/claw` invocations with coding tasks each spawn independent `ao` sessions in parallel tmux windows — no longer sequential through the gateway
- **Slash commands**: Resolved before dispatch in both paths (command definition inlined into task)
- **Task file cleanup**: Temp task files are kept at `/tmp/openclaw/.claw-task-*.txt` for manual resend if needed
- **Bead creation**: If no issue ID is detected in a coding task, a bead is created automatically via `br create`
- **Beads**: `bd-*` (this repo) and `orch-*` (harness); orch-sq2 tracks parallel ao spawn routing
