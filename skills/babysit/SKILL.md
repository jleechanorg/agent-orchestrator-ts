---
name: babysit
description: Watch one or more AO worker tmux sessions, classify their state (WORKING/IDLE/QUEUED/DEAD/COMPLETED), auto-remediate known failures (trust TUI, queued prompt), and push-notify on stuck sessions. Reuses ao-session-monitor state detection. Use /babysit to start a monitoring loop on a specific worker, all active workers, or workers matching a PR/branch.
type: skill
---

# Babysit — AO Worker Supervisor

**Purpose:** Watch AO worker tmux sessions, classify state, auto-remediate known failures, and notify on stuck or dead shells. Sits *alongside* the launchd-managed `ao lifecycle-worker` (which runs the system-level reaction/poll loop) — `babysit` is the **Claude-side observer** for individual spawned sessions.

**Use when:**
- You just spawned an AO worker (`ao spawn` / `ao spawn -p project "..."`) and want to keep an eye on it
- An existing worker has been "Baked for Xm" too long and you want a programmatic check
- You suspect the agy/antigravity trust TUI is blocking a worker (bd-jya0)
- You want a per-worker "what is each one doing right now" snapshot
- A worker is queued (lifecycle-worker sent it a message) but not acting

**Do NOT use when:**
- The system-level reaction loop is broken (use `/auton` — it diagnoses the jleechanclaw + AO autonomy chain end-to-end)
- A specific worker has a known error (use `/ao-lifecycle-triage` for log-driven triage)
- You want to spawn a worker (use `/ao-worker-dispatch`)
- You want to detect the state of a single pane once (use `/ao-session-monitor` — babysit uses it internally for one-pane detection but is multi-worker / multi-cycle)

## Cross-references

| Skill | When to use instead |
|---|---|
| `/ao-session-monitor` | Single pane, one-shot classification (babysit embeds the same one-liner) |
| `/babysit-openclaw` | Slack-thread-based openclaw monitoring (different model — openclaw posts to Slack; AO workers use tmux) |
| `/auton` | System-level: why is the autonomous chain not driving PRs to N-green? |
| `/ao-lifecycle-triage` | One stuck worker, deep log dive |
| `/ao-spawn-gate` | Pre-spawn resource check |

## State classification (from `ao-session-monitor`)

| Indicator | State | Babysit action |
|---|---|---|
| `✻✶✳✽✾` + duration, `Running…`, `Bash(`/`Read(` etc. in last 20 lines | **WORKING** | No action — log every 5 min |
| `Baked for Xm` or `Sautéed for Xm` and X ≥ 30 | **STALLED-COMPLETED** | Push-notify: "Worker has been completed-but-untouched for Xm — review output" |
| `❯` prompt with no activity indicators in 20 lines | **IDLE** | If lifecycle-worker should have sent a message, push-notify |
| `Press up to edit queued messages` | **QUEUED** | If queued > 10 min, push-notify (worker may be stuck on input) |
| Trust TUI: "Do you trust the contents of this project?" with no auto-`--add-dir` | **TUI-BLOCKED** | Auto-remediate: send Enter to select "Yes, I trust this folder" |
| `+uncommitted` in status bar with no recent `Bash(git` in 25 lines | **HAS-WORK-NO-COMMIT** | Push-notify at 15 min: "Worker has uncommitted edits and is not committing" |
| Pane dead (no `❯`, no activity indicators, no recent tool output) for > 5 min | **DEAD** | Push-notify: "Worker tmux pane is dead — manual respawn required" |

## Auto-remediation policy (user-scope, opt-in)

- **Trust TUI (`Do you trust...`)**: send Enter once. Only if the prompt is visible. Never send on a `❯` prompt without the trust question.
- **Queued prompt with Enter required**: do not send — this is destructive. Push-notify only.
- **Dead shell**: NEVER auto-respawn. Push-notify with the spawn command you would have used. User decides.
- **Stalled completed**: NEVER auto-respawn or auto-commit. Push-notify.
- **Idempotency**: each remediation is gated on a sentinel — do not send Enter twice in 60s, do not push-notify the same condition twice in 30 min.

## Modes

### Mode 1 — One-shot snapshot (no loop)

```
/babysit snapshot [session-name]
/babysit snapshot              # all ao-* sessions
/babysit snapshot ao-6312      # one session
```

Runs the ao-session-monitor one-liner, prints the table, exits.

### Mode 2 — Watch a single worker

```
/babysit watch <session-name> [--max-min N]
/babysit watch ao-6312 --max-min 60
```

Polls every 60s. Auto-remediates TUI/queue. Push-notifies on stalled/dead. Exits when:
- Worker reaches COMPLETED and PR is merged/closed (then push-notify "Worker finished cleanly")
- User says `stop` / `cancel`
- `--max-min` reached (default 90)
- Worker enters DEAD state

### Mode 3 — Watch all active AO workers

```
/babysit watch-all [--max-min N]
```

Same as Mode 2, but applies to all `ao-*` tmux sessions. Per-worker status table printed every 5 min.

### Mode 4 — Watch by PR/branch

```
/babysit pr <PR#|branch> [--max-min N]
/babysit pr 661
/babysit pr fix/bd-rgk0-skeptic-cron-trigger-age-filter
```

Resolves the PR/branch → tmux session via `ao list` and the worktree's git state, then watches.

## Internals

### Detection primitive (from ao-session-monitor)

```bash
for s in $(tmux list-sessions 2>/dev/null | grep "ao-[0-9]" | cut -d: -f1); do
  name=${s##*-}
  last=$(tmux capture-pane -t "$s" -p -S -20)
  pr=$(echo "$last" | grep -oE "PR: #[0-9]+" | head -1)
  uc=""; echo "$last" | grep -q "uncommitted" && uc="+uc"
  activity=$(echo "$last" | grep -oE "[✻✶✳✽✾] [A-Za-z]+…[^)]*\)" | tail -1)
  if [ -n "$activity" ]; then echo "  $name: WORKING $pr $uc ($activity)"
  elif echo "$last" | grep -qE "Baked|Sautéed"; then echo "  $name: completed $pr"
  elif echo "$last" | grep -q "queued"; then echo "  $name: QUEUED $pr"
  else echo "  $name: idle $pr $uc"
  fi
done
```

### TUI-block detection (bd-jya0)

```bash
tmux capture-pane -t "$s" -p -S -30 | grep -q "Do you trust the contents of this project" \
  && tmux send-keys -t "$s" Enter
```

Pre-check: only send Enter if no Enter has been sent in the last 60s (sentinel file `~/.cache/babysit/${s}.last_enter`).

### Push notification (Claude native)

```python
from claude_code import push_notification  # conceptual
# Use the PushNotification tool with:
#   message: "ao-6312 stalled-completed for 35m — review output"
#   status: proactive
```

Cap: 1 push per session per 30 min. Sentinel: `~/.cache/babysit/${s}.last_notify`.

### Watch loop

The bash one-liner runs every 60s. Each iteration:
1. Refresh state for all watched sessions
2. Apply remediation policy (TUI-block, idempotent)
3. Diff against last seen state — only push-notify on transitions (WORKING→STALLED, IDLE→QUEUED+10m, etc.)
4. Print table every 5 min (or on every transition, whichever is less noisy)

### Sentinel layout

```
~/.cache/babysit/
  ao-6312.last_enter          # epoch ms of last Enter sent
  ao-6312.last_notify         # epoch ms of last push-notify
  ao-6312.last_state          # WORKING|IDLE|QUEUED|DEAD|COMPLETED|TUI
  ao-6312.started_at          # epoch ms of first observation
```

## Stop conditions

- Watch loop exits on: user `stop`, `--max-min` reached, DEAD state, COMPLETED + PR merged
- One-shot snapshot always exits after one pass
- If the user is also running `/auton` or `/eloop`, babysit must not stack — exit cleanly and let those drive the system-level state

## Output format (snapshot)

```
Session         State           PR      Uncommitted  Last activity
ao-6312         WORKING         #661    no           ✻ Cascading… (3m 12s)
ao-6309         TUI-BLOCKED     #?      no           (trust prompt)
ao-6305         STALLED-CMP     #657    yes          Baked for 42m
ao-6302         DEAD            —       —            (no output 8m)
```

## Examples

### Watch the worker I just spawned

```
> /babysit watch ao-6312
Watching ao-6312 (PR #661, branch fix/bd-rgk0-skeptic-cron-trigger-age-filter)
Polling every 60s. Will push-notify on stalled/dead/TUI-block. Max run 90 min.
[17:42:01] WORKING — ✻ Germinating… (0m 12s)
[17:43:01] WORKING — ✻ Germinating… (1m 14s)
[17:44:01] WORKING — ✻ Running tools… (2m 03s)
[17:45:30] TUI-BLOCKED — "Do you trust..." → sent Enter
[17:45:35] WORKING — ✻ Reading… (0m 04s)
...
```

### Snapshot of all workers

```
> /babysit snapshot
Session         State           PR      Uncommitted  Last activity
ao-6312         WORKING         #661    no           ✻ Germinating… (0m 30s)
ao-6309         IDLE            —       no           (no activity 4m)
ao-6305         STALLED-CMP     #657    yes          Baked for 42m
```

### Watch by PR

```
> /babysit pr 661
Resolved 661 → ao-6312 (worktree /Users/jleechan/.worktrees/agent-orchestrator/ao-6312, branch fix/bd-rgk0-...)
Watching ao-6312. Same as /babysit watch ao-6312.
```

## DRIVER mode — when babysit must send specific fix instructions (bd-snx3)

By default, babysit **observes and reports**: it posts status updates but does not steer workers. In DRIVER mode, babysit takes the next step when it detects a stuck-on-failure pattern: it extracts the specific failure and sends an `ao send` with an exact fix instruction.

**Trigger rule (mandatory):** if the same CI gate failure (same check name, same error class) appears in **≥2 consecutive polls** for the same worker, babysit MUST switch to DRIVER mode for that worker.

**What to extract (the minimum to act on):**
- File path and line number from the failure log (e.g., `packages/cli/src/doctor.ts:142`)
- The specific wrong value or behavior (e.g., `dist/index.js argv shape not recognized in non-canonical check`)
- The exact change to make (e.g., `change regex to accept '/path/dist/index.js' as canonical binary`)

**What to send (use the `SendMessage` / `ao send` channel, NOT just a push notification):**

```bash
ao send <session-id> "DRIVER (babysit): <check-name> failing 2+ ticks.
Failure: <one-line description of the error>
Fix: change <file>:<line> — <specific patch in plain English>
Verify: <command to run before pushing> (e.g., pnpm -C packages/cli test)"
```

**Idempotency:** one DRIVER send per failure-class per 30 minutes (sentinel `~/.cache/babysit/${s}.last_driver_${checkname}`). After sending, babysit reverts to observer mode for the same check name until the failure either changes class or resolves.

**Do NOT in DRIVER mode:**
- Do not send a generic "keep working" or "fix CI" message — that is the failure pattern. If you cannot extract a specific file:line, push-notify the user instead of sending a vague driver message.
- Do not send `ao send` with raw `gh run` output pasted in. Distill to one specific actionable instruction.
- Do not auto-fix the worker's code (babysit does not have write access; it only steers).
- Do not stack DRIVER sends with `/auton` or `/eloop` — those are system-level drivers; let them run or stop babysit.

**Why this exists:** babysit's success metric was "status posted" not "failure fixed." Generic nudges do not move workers that have already tried and failed — they need exact file:line fix instructions. Observed in PR #7618 (rate-limit) over 4+ hours with 15+ babysit status updates and zero progress. Memory: [[babysit-not-a-driver]]. See also [[pr-driver-loop-contract]] in `~/.claude/CLAUDE.md`.

## Anti-patterns

- **Do not run `/babysit` and `/auton` simultaneously** — they overlap and produce duplicate push-notifications
- **Do not auto-respawn dead workers** — the spawn parameters (PR, branch, claim, model override) are not recoverable from a dead tmux pane; user must re-spawn explicitly
- **Do not send Enter on a `❯` prompt without verifying a question is being asked** — Enter on an empty prompt submits a blank, which is harmless but noise
- **Do not babysit more than 8 workers at once** — the polling loop is bash, not parallel, and the user attention budget caps out fast
- **Do not extend `--max-min` beyond 180 without explicit user approval** — long watches consume push-notification quota and can mask real alerts
- **Do not send a generic `ao send` "fix CI" message** — that is the exact failure mode DRIVER mode was created to prevent. If you cannot extract a specific file:line + change, push-notify the user instead.

## Known failure modes

| Failure | Detection | Recovery |
|---|---|---|
| tmux server not running | `tmux has-session` returns 1 | Push-notify: "tmux server down — restart with `tmux start-server`" |
| ao-* sessions exist but capture-pane returns empty | `last == ""` | Mark DEAD, push-notify |
| Sentinel dir not writable | `mkdir -p` fails | Print to stderr, continue without idempotency (degraded) |
| `ao list` not in PATH | `which ao` returns empty | Print to stderr, use tmux-only mode (no PR resolution) |
| Push-notification tool unavailable | ImportError | Fall back to printing to stdout + writing a sentinel flag file `~/.cache/babysit/${s}.needs_human` |

## Why not just use `Monitor` tool directly?

`Monitor` watches a long-running script and emits a notification per stdout line — perfect for tailing logs. `babysit` is *stateful*: it diffs state across polls, applies idempotency via sentinel files, and remediates only on transitions. A `Monitor` invocation of `tmux capture-pane` would either flood notifications (every 60s) or miss transitions (if filtered too tightly). The stateful watch loop is the right primitive.

## Related skills

- `/ao-session-monitor` — single-pane one-shot detection (babysit embeds its one-liner)
- `/babysit-openclaw` — Slack-thread-based, single-shot, different model
- `/auton` — system-level autonomy diagnostic
- `/ao-lifecycle-triage` — log-driven deep triage of a single stuck worker
- `/evolve-loop` / `/eloop` — autonomous loop; babysit is intentionally NOT autonomous (always opt-in)
