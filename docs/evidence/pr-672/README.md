# PR #672 Terminal Evidence — doctor.sh v2 + Watchdog-of-Watchdogs

**Captured:** 2026-06-10 11:21 UTC
**PR:** [jleechanorg/agent-orchestrator#672](https://github.com/jleechanorg/agent-orchestrator/pull/672)
**Author HEAD:** `ef2dd3769 [agento] docs(evidence): add v3 TDD Red→Green for all 6 doctor-v2 checks`
**Evidence script:** `/tmp/tdd-all-checks-v4.sh` (this commit)

## What this evidence covers

This is the **single consolidated evidence bundle** for PR #672. It captures
TDD Red→Green cycles for the **two restored/added watchdog scripts** and
**all six new doctor-v2 checks**. Each Red phase is either:

1. **A real production-state observation** (e.g. Check 1 shows the actual
   `~/.hermes/agent-orchestrator.yaml` currently has 0 `scm:` entries —
   this is the live 2026-06-10 regression that motivated the PR); or
2. **A controlled reversible induction** (env override of a known-bad
   sentinel, a temporary file rename, a `launchctl bootout` of a single
   watchdog) that is **fully restored** to the original production state
   in the same script run. The Green phase verifies the original state
   was correctly restored.

The bundle replaces and consolidates prior provisional bundles
(`pr-672/`, `pr-672-v2/`, `pr-672-v3/`) — those are removed from this PR
to avoid inconsistent worker counts and overlapping scope.

## The eight demonstrations

### Phase 1 — `ai.hermes-watchdog` restoration (Goal 1)

- **Red (historical, pre-PR):** `last exit code = 127` for 158+ consecutive
  runs since May 2026 — `/bin/bash: .../hermes-watchdog.sh: No such file or directory`.
- **Green (post-PR, current production state):** script present at
  `/Users/jleechan/.hermes/scripts/hermes-watchdog.sh` (5680 bytes),
  syntax OK, launchd `last exit code = 0`.

### Phase 2 — `ai.agento.health-guardian` Tier 2 (Goal 2)

- **Red (historical, pre-PR):** `scripts/ai.agento.health-guardian.sh`
  did not exist; no Tier 2 watchdog; max blindness window = unbounded.
- **Green (post-PR, current production state):** script present
  (8453 bytes), syntax OK, live execution reports
  `all checks green (workers=10)`. Frozen template path verified at
  `launchd/ai.agento.health.plist.template`.

### Check 1 — `scm:` config in staging

- **Red (real production state):** `grep -c "scm:" /Users/jleechan/.hermes/agent-orchestrator.yaml`
  returns `0`. The 2026-06-10 regression is **active right now** — without
  operator intervention, the Skeptic-cron silently returns 0 for all PRs.
- **Green (test fixture):** `HERMES_STAGING_CONFIG=/tmp/doctor-v2-test/staging-fixed.yaml`
  → 10/10 projects have `scm:` → check passes.

### Check 2 — Skeptic-cron 24h age filter order (bd-rgk0 guard)

- **Red (pre-bd-rgk0 fix):** `git show ac2207e1e^:packages/core/src/skeptic-cron-local.ts`
  shows the filter at L276 ran **before** per-PR evaluation, silently
  dropping fresh `/skeptic` comments on >24h PRs.
- **Green (post-PR #661):** trigger check at L97 fetched **first**;
  `updatedAt` dedup at L226 applied **after** trigger check. PASS.

### Check 3 — `AO_BOT_GH_TOKEN` not redacted

- **Red (controlled env override):** `env AO_BOT_GH_TOKEN="__OPENCLAW_REDACTED__"`
  → check FAILs with the exact stale-sentinel pattern.
- **Green (real production state):** real `ghp_...` token, length 40.

### Check 4 — `dist/index.js` md5 match

- **Red (controlled, /tmp):** copy of source dist + `echo "garbage" >>`
  → md5 differs from source. (The corrupted copy is in `/tmp` and is
  removed at the end of the script.)
- **Green (real production state):** `aa9b94d7956b8d4b66dd7e3182bfbb1b`
  matches between source `packages/cli/dist/index.js` and the binary
  symlink target.

### Check 5 — `running.json` present

- **Red (controlled, temporary rename):** `mv running.json running.json.bak.tdd`
  → check FAILs with the exact fix instruction. Restored immediately.
- **Green (real production state):** `running.json` present (370 bytes).

### Check 6 — Watchdog chain (Tier 1 + Tier 2 + cross-watchdog)

- **Red (controlled, `launchctl bootout`):** `launchctl bootout gui/$(id -u)/ai.agento.health`
  → check WARNs "watchdog plist ai.agento.health not registered with launchd".
  Re-bootstrapped immediately.
- **Green (real production state):** all 3 watchdogs registered:
  `ai.agento.health`, `ai.agento.health-guardian`, `ai.hermes-watchdog`.

## Verification (live, current production state)

```
$ bash scripts/ao-doctor-v2.sh
=== ao-doctor-v2 (2026-06-10 fragility audit) ===
FAIL staging config /Users/jleechan/.hermes/agent-orchestrator.yaml has NO 'scm:' field …
PASS skeptic-cron age filter is AFTER trigger check at code level (bd-rgk0 guard)
PASS AO_BOT_GH_TOKEN is a real token (length=40, prefix=ghp_...)
PASS dist md5 matches between source and binary
PASS running.json present at /Users/jleechan/.agent-orchestrator/running.json
PASS watchdog plist ai.agento.health is registered
PASS watchdog plist ai.agento.health-guardian is registered
PASS watchdog plist ai.hermes-watchdog is registered
=== summary: 7 pass, 0 warn, 1 fail ===
```

The single FAIL is the **real, live 2026-06-10 regression** that the
PR is designed to detect — its presence here proves the check works.

## Files

| File | Size | Purpose |
|------|------|---------|
| `cast.cast` | 8.7 KB | asciicast v2 raw (130 frames at 0.5s/line) |
| `cast.gif` | 4.9 MB | Animated GIF (solarized-dark, 12pt) |
| `cast.mp4` | 3.8 MB | MP4 (libx264, yuv420p, faststart) |
| `cast.vtt` | 2.3 KB | Caption track with 10 timed cues |
| `raw-typer.txt` | 5.7 KB | Raw `script -q` capture (input source) |
| `README.md` | this file | Documentation |
| `checksum.txt` | 0.4 KB | SHA-256 of all artifacts |

## Reproducibility

```bash
cd /Users/jleechan/.worktrees/agent-orchestrator/ao-6321
bash /tmp/tdd-all-checks-v4.sh
# Then re-run the same script-to-asciicast + agg + ffmpeg pipeline shown
# in skills/tmux-video-evidence/SKILL.md to regenerate the artifacts.
```

The script is idempotent and side-effect-free except for the
controllable inductions noted above; all inductions are reversed in
the same script run before exit.
