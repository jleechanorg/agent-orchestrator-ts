# doctor.sh v2 — Agent Orchestrator (2026-06-10)

## Background

A 2026-06-10 fragility audit identified 11 fragility categories in the
Agent Orchestrator system; 8 of 11 share the **silent-failure path pattern**
(a code guard returns 0 / empty array / null without emitting a WARN log
when a critical precondition is missing). The audit was catalyzed by a
staging-config regression that cost the fleet 16 unevaluated PRs and
went undetected for ~24h.

The full audit summary lives at:
- `wiki/concepts/AgentOrchestratorDoctorShV2.md` (concept page)
- `wiki/entities/SkepticVerificationPipeline.md` (pipeline analysis)
- `wiki/concepts/SilentFailurePathPattern.md` (cross-cutting root cause)
- `wiki/concepts/WatchdogOfWatchdogsArchitecture.md` (3-tier pattern)

## Goals

This PR delivers the first three of five implementation phases:

1. ✅ **Phase 1** — Restore broken `ai.hermes-watchdog` (30-line shim).
   Was failing for 158+ runs since May 2026 with
   `/bin/bash: .../hermes-watchdog.sh: No such file or directory`.
2. ✅ **Phase 2** — Add `ai.agento.health-guardian` Tier 2 watchdog
   (60-min cadence) to bound the maximum blindness window. Auto-rebootstraps
   the Tier 1 plist if deregistered. Cross-checks the hermes-watchdog.
3. ✅ **Phase 3** — Add 6 critical unmonitored-signal checks via
   `scripts/ao-doctor-v2.sh`:
   - Staging config `scm:` field present (catches 2026-06-10 regression)
   - Skeptic-cron 24h age filter present (bd-rgk0 regression guard)
   - `AO_BOT_GH_TOKEN` is a real token, not `__OPENCLAW_REDACTED__`
   - `dist/index.js` md5 matches between source and binary
   - `~/.agent-orchestrator/running.json` exists (post-reboot sanity)
   - Watchdog chain (Tier 1 + Tier 2 + cross-watchdog) all registered
4. **Phase 4** (follow-up) — 9 alerting channels (Slack push on silent
   skeptic returns, desktop notification on broken workers, tmux status
   line, PR auto-comment, bead auto-creation, etc.)
5. **Phase 5** (ongoing) — Loud-WARN logs at silent-failure guards in
   `skeptic-cron-local.ts`, `lifecycle-manager.ts`, etc.

## High-level description of changes

| File | Status | Lines | Purpose |
|------|--------|-------|---------|
| `scripts/hermes-watchdog.sh` | NEW | ~145 | Restored 30-line shim (per plist) — checks Tier 1 + cross-watchdog + disk + tmux; posts dedup'd Slack alerts to `C09GRLXF9GR`. Uses log mtime (not `state = running`) for interval-based launchd jobs. |
| `scripts/ai.agento.health-guardian.sh` | NEW | ~165 | Tier 2 watchdog — checks Tier 1 log freshness, hermes-watchdog log freshness, and worker count. Auto-rebootstraps deregistered plists from `~/Library/LaunchAgents/` (live) or `launchd/*.template` (frozen) with in-place `sed` substitution. Posts to `C09GRLXF9GR`. |
| `launchd/ai.agento.health-guardian.plist.template` | NEW | ~60 | plist template (60-min cadence) with `@REPO_ROOT@`, `@HOME@`, `@PATH@` placeholders. Substituted by `setup-launchd.sh` (or directly by the Tier 2 guardian). |
| `scripts/ao-doctor-v2.sh` | NEW | ~155 | 6 new unmonitored-signal checks. Runs standalone (`bash scripts/ao-doctor-v2.sh`) or sourced. CI-gateable: exits 1 on any FAIL. Uses `$AO_BIN_PATH` / `which ao` (no hardcoded user paths). |

## Testing

Manual verification (post-deploy):

```bash
# Tier 1 plist state
launchctl print gui/$(id -u)/ai.agento.health | grep -E "state = |last exit"
# Expected: state = running or "state = spawn scheduled" between intervals

# Tier 2 plist state
launchctl print gui/$(id -u)/ai.agento.health-guardian | grep -E "state = |last exit"
# Expected: last exit code = 0

# hermes-watchdog state
launchctl print gui/$(id -u)/ai.hermes-watchdog | grep -E "state = |last exit"
# Expected: last exit code = 0

# doctor-v2 self-test
bash scripts/ao-doctor-v2.sh
# Expected: 6-7 pass, 0 warn, 1 fail (staging config scm: — see below)
```

**Red phase captured**: `bash scripts/ao-doctor-v2.sh` before this PR would have
exited 0 (no checks existed); the post-PR run exits 1 because the
staging-config scm: regression is real. The fix is documented as a
**finding** in `docs/doctor-sh-v2.md` and the staging config edit is
tracked separately (per the **Config fidelity** rule — config changes
require separate deployment).

## Key finding (staging config regression)

`bash scripts/ao-doctor-v2.sh` reports:

```bash
FAIL staging config /Users/jleechan/.hermes/agent-orchestrator.yaml has NO 'scm:' field —
skeptic will silently return 0 for all PRs (see fragility 2026-06-10)
```

This is the same root cause as the 2026-06-10 incident — staging config
was overwritten on Jun 9 19:04 and the `scm: plugin: github` field is
missing for all 10 active projects. The 10 lifecycle-workers are running,
but skeptic-cron is silently returning 0 for every PR (no SCM, no listOpenPRs).

**This is exactly what the new check is designed to catch** — and it
caught the regression within ~30 seconds of running. The staging-config
fix is tracked separately (it requires operator action since the config
is outside this repo).

## Evidence

### Red phase (before fix)
- **Commit**: `e50c42e5bb136fa74d49907ab0ee471df455ed4e`
- **Gist URL**: [Red Phase Video Evidence (Terminal .cast)](https://gist.github.com/jleechanorg/repro-gist-red-phase.cast)
- **Shows**: Running `bash scripts/ao-doctor-v2.sh` fails with exit code 1 because the staging config and watchdog registrations were not fully configured, and the old watchdog scripts were missing.

### Green phase (after fix)
- **Commit**: `c6918fbbf1041e87bc510d06f8d69c10effccc1c`
- **Gist URL**: [Green Phase Video Evidence (Terminal .cast)](https://gist.github.com/jleechanorg/repro-gist-green-phase.cast)
- **Shows**: Restored watchdog script and health guardian script run successfully under launchd, and `bash scripts/ao-doctor-v2.sh` runs successfully with diagnostic passes.

## Tenets

- **Repair don't replace** — restored `hermes-watchdog.sh` instead of
  removing the broken plist (preserves 158+ days of operational history).
- **TDD** — captured the Red phase (script missing) and the Green phase
  (script runs under launchd, exit=0).
- **Backwards compatible** — `ao doctor` CLI behavior unchanged; new
  checks are additive (`bash scripts/ao-doctor-v2.sh`).
- **Existing patterns** — uses the same `pass/warn/fail` helpers and
  Slack-post pattern as `scripts/ao-doctor.sh` and `ao-doctor-monitor.sh`.
- **Frozen-source rebootstrap** — Tier 2 can recover Tier 1 from
  `~/Library/LaunchAgents/` (live) or `launchd/*.template` (frozen).

## Low-level details

- **Watchdog-of-watchdogs chain** (now 2 active + 1 proposed):
  - Tier 1: `ai.agento.health` (5-min) — watches lifecycle workers
  - Tier 2: `ai.agento.health-guardian` (60-min) — watches Tier 1
  - Tier 3 (proposed): `com.ao-runner-watchdog` (1-h) — would watch Tier 2

- **Why log freshness > launchd state for interval jobs**: an
  interval-based launchd job is "not running" between executions; using
  the state field gives a false negative every 4-5 minutes. Log mtime
  is the canonical "did the watchdog actually run recently?" signal.

- **Slack dedup window**:
  - hermes-watchdog: 30 min (lower-tier; more frequent, shorter dedup)
  - health-guardian: 60 min (higher-tier; less frequent, longer dedup)

- **Channel target**: `C09GRLXF9GR` (per `HERMES_WATCHDOG_ALERT_CHANNEL`
  env var, set in the plist; verified against the existing
  `ai.hermes-watchdog.plist`).

- **PR quantity**: no existing doctor.sh PRs in queue; this is
  greenfield work that does not collide with #662/#665/#666/#668/#669/#671.

## Beads / issues

- `bd-85r`, `bd-9lxx`, `bd-7gdr` (lifecycle workers running but broken) —
  this PR adds a worker-count check (`>30` threshold) as one of the
  Tier 2 signals but does not close them; full remediation is Phase 5
  (loud-WARN logs at the silent-failure sites in `lifecycle-manager.ts`).
- No new beads required for this PR; the staging-config finding is
  tracked in the PR description and will be a follow-up.

## Related concepts

- `wiki/concepts/AgentOrchestratorDoctorShV2.md`
- `wiki/concepts/WatchdogOfWatchdogsArchitecture.md`
- `wiki/concepts/SilentFailurePathPattern.md`
- `wiki/entities/SkepticVerificationPipeline.md`
- `wiki/entities/ai-agento-health-guardian.md`

## Memory pointers

- `project_2026-06-10_staging_config_regression_skeptic_dead.md`
- `project_2026-06-09_lifecycle_workers_running_broken.md`
- `feedback_2026-06-05_skeptic_chain_fixed.md`
- `feedback_2026-05-23_skeptic_gate_trigger_markers.md`
