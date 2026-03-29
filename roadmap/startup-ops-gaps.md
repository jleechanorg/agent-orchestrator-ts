# AO Startup & Operations Gaps

> Documented from manual intervention session: 2026-03-22
>
> Every item below required manual human intervention during a routine
> `start-all.sh` + health check cycle. Each is a harness gap that should
> be automated or prevented.

---

## Gap 1 — YAML duplicate key crashes all `ao` commands

**What happened**: `~/.openclaw/agent-orchestrator.yaml` had an orphan
`agentConfig` + `agentRules` block (for `mctrl_test`) nested under the
`worldai-claw` project with the same key as an existing sibling. YAML
parser threw `DUPLICATE_KEY` at line 317, making every `ao` command fail
silently with a stack trace.

**Manual fix**: Read the file, identified the orphan block, removed lines
317–324.

**Root cause**: A project config fragment was pasted without its header
(`mctrl-test:` key). The duplicate lived undetected because `ao start`
uses a different YAML path than `ao session ls`.

**Recommended fix**:
- Add a `ao config validate` subcommand (or run `python3 -c "import yaml;
  yaml.safe_load(open(path))"` in `start-all.sh`) before `ao start`.
- Add a CI/lint step that validates `agent-orchestrator.yaml` on every
  commit to `~/.openclaw` (jleechanclaw repo).
- Add harness test: `scripts/validate-config.sh` that parses the yaml and
  exits non-zero on parse errors.

---

## Gap 2 — Duplicate lifecycle-worker processes accumulate across restarts

**What happened**: After multiple `start-all.sh` runs (manual + daemon
restarts), 5 `ao lifecycle-worker agent-orchestrator` processes were
running simultaneously. Only the newest was valid.

**Manual fix**: `ps aux | grep lifecycle-worker` → `kill` of 4 stale PIDs.

**Root cause**: `start-all.sh` uses `nohup … &` without first checking
if a lifecycle-worker for that project is already running.

**Recommended fix**:
- `start-all.sh` should check for existing lifecycle-workers before
  launching: `pgrep -f "ao lifecycle-worker $PROJECT"` → skip if found.
- Or `ao lifecycle-worker` should self-elect via a PID file and refuse to
  start a second instance (lifecycle-manager already writes a PID file —
  expose a `--check-running` flag).
- Add to `doctor.sh`: detect and report duplicate lifecycle-workers.

---

## Gap 3 — Stale tmux sessions from old config namespace accumulate

**What happened**: Sessions from an old `8b4446256796` namespace (different
`agent-orchestrator.yaml` directory hash) lingered in tmux for 12+ hours.
`ao session ls` doesn't see them because they belong to a different data
dir. They silently inflate the tmux session count toward the spawn gate.

**Manual fix**: Identified by hash prefix mismatch, killed with `tmux
kill-session`.

**Root cause**: When the config file is moved/renamed, the old namespace
hash is abandoned but tmux sessions remain.

**Recommended fix**:
- `doctor.sh` / `start-all.sh` should scan tmux sessions and flag any
  with an unrecognized namespace hash.
- Lifecycle-worker should kill its own tmux sessions on graceful shutdown.
- Add a `ao gc` (garbage collect) subcommand: kills tmux sessions whose
  namespace hash doesn't match any known config.

---

## Gap 4 — `start-all.sh` not in the repo it was called from

**What happened**: `start-all.sh` lives in `scripts/` of the AO repo but
the user invoked it via `~/.openclaw/`. The script needs `AO_CONFIG_PATH`
explicitly set or it falls back to a stale default path
(`~/projects_reference/agent-orchestrator/agent-orchestrator.yaml`).

**Manual fix**: Set `AO_CONFIG_PATH=~/.openclaw/agent-orchestrator.yaml`
explicitly.

**Root cause**: The default config path in `start-all.sh` is not the
canonical path (should be `~/.openclaw/agent-orchestrator.yaml`).

**Recommended fix**:
- Change default in `start-all.sh` to `~/.openclaw/agent-orchestrator.yaml`.
- Or install a `~/.openclaw/start-all.sh` symlink pointing to the repo
  script so it's always available at the expected location.
- Document the correct invocation in `~/.openclaw/README.md`.

---

## Gap 5 — PR spawn failures due to stale worktrees (git exit 128)

**What happened**: Spawning sessions for 6 PRs (#98, #95, #93, #90, #82,
#60) failed with `failed to run git: exit status 128`. These PRs had been
worked on by killed sessions, leaving stale worktrees in
`~/.worktrees/agent-orchestrator/`.

**Manual fix**: None yet — blocked by tmux count gate. Requires manual
`git worktree remove` for stale entries.

**Root cause**: Lifecycle-worker worktree cleanup (PR #92) doesn't always
run on killed sessions before the tmux pane disappears.

**Recommended fix**:
- `ao spawn` should detect stale worktrees (`git worktree list` + compare
  to active sessions) and prune before attempting to clone.
- Add `scripts/check-stale-worktrees.sh` to doctor/monitor.
- Fix #92 (worktree cleanup on all terminal transitions) is already in
  flight — unblock it.

---

## Gap 6 — No single `ao health` / startup validation command

**What happened**: Health verification required running ~8 separate
commands manually: `ps aux | grep lifecycle-worker`, `tmux list-sessions`,
`ao session ls`, `gh pr list`, rate limit check, yaml parse, etc.

**Manual fix**: N/A — manual labor each time.

**Recommended fix**:
- Implement `ao health` (or promote `doctor.sh` / PR #88's ao-doctor-monitor)
  as a first-class `ao` subcommand.
- Output: lifecycle-worker status per project, orchestrator session status,
  active session count, tmux session count, yaml parse status, open PR
  coverage percentage, rate limit budget.
- Run as part of `start-all.sh` at the end.

---

---

## Gap 7 — Self-hosted runners silently absent for new AO-managed repos

**What happened** (2026-03-29): PR #273 (`fix/all-tests-self-hosted`) had all CI checks queued with 0 runners for 17+ hours. The worker correctly diagnosed "0 runners — CI cannot progress" but had no recovery path. Root cause: `~/.ao-runner.d/` had entries for `jleechanclaw` and `worldai_claw` but NOT `agent-orchestrator`. The `com.ao-runner.plist` runs once at boot — no watchdog.

**Manual fix**: Created `~/.ao-runner.d/jleechanorg--agent-orchestrator/.env`, ran `start-runner.sh`, bootstrapped watchdog plist.

**Root cause**: New repos added to AO projects config require a manual `~/.ao-runner.d/` entry — there is no detection or alerting when a configured project has no runner coverage.

**Implemented fix** (PR #294, bd-sdl):
- `ao doctor` now checks runner health per configured repo (calls `gh api .../runners`)
- `ao doctor --fix` restarts dead containers (idempotent — skips healthy repos)
- New `com.ao-runner-watchdog.plist` (StartInterval=3600) runs `ao doctor --fix` hourly

**Remaining gap** (bd-TODO):
- `ao doctor --fix` still cannot auto-provision missing `~/.ao-runner.d/` entries for repos not yet configured — requires a project-id → repo-URL mapping. See follow-on bead.

---

## Priority order

| Pri | Gap | Effort | Impact |
|-----|-----|--------|--------|
| P0 | Gap 1: YAML validation in start-all.sh | S | Prevents all `ao` commands from failing |
| P0 | Gap 2: Idempotent lifecycle-worker launch | S | Prevents duplicate processes |
| P1 | Gap 5: Stale worktree cleanup on spawn | M | Unblocks PR coverage |
| P1 | Gap 6: `ao health` command | M | Reduces manual ops burden |
| P1 | Gap 7: Runner health detection + watchdog | M | Prevents silent 17h+ CI stalls |
| P2 | Gap 3: Stale namespace tmux GC | M | Keeps tmux count accurate |
| P2 | Gap 4: start-all.sh config default | XS | Removes footgun |
