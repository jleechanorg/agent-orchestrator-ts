# PR #672 Skeptic-fix evidence (head `f49672806`)

**Captured:** 2026-06-10 03:58 UTC
**PR:** [jleechanorg/agent-orchestrator#672](https://github.com/jleechanorg/agent-orchestrator/pull/672)
**Author commit:** `f49672806 [agento] fix(doctor-v2): address Skeptic 3-issue FAIL`
**Base commit:** `329894c9a Merge feat/doctor-sh-v2-fragility-fix-2026-06-10`

## What this evidence covers

A prior Skeptic verdict on the merge commit `329894c9a` returned **FAIL** with three concrete blockers. This evidence bundle captures the post-fix state on `f49672806` showing each blocker resolved.

## The 3 Skeptic blockers (and the fixes)

### 1. Bash `local` outside any function — `ai.agento.health-guardian.sh:137`

**Before (broken):**
```bash
log "frozen template found at $TIER1_FROZEN_PLIST — substituting placeholders"
local tmp_plist
tmp_plist=$(mktemp "/tmp/health-guardian-XXXXXX.plist")
```

The script is a top-level script body — only `log`, `post_slack`, and `dedup_should_send` are real functions. `local tmp_plist` outside a function is a silent no-op in bash 3.2 and a hard error under `set -u`. Either way, the variable leaks to the global scope.

**After (fixed):**
```bash
log "frozen template found at $TIER1_FROZEN_PLIST — substituting placeholders"
tmp_plist=$(mktemp "/tmp/health-guardian-XXXXXX.plist")
```

### 2. Project-counting regex over-count — `ao-doctor-v2.sh:42`

**Before (broken):**
```bash
project_count=$(grep -cE "^\s+[a-zA-Z][a-zA-Z0-9_-]*:$" "$cfg" 2>/dev/null || echo 0)
```

This regex matches any 2-or-4-space-indented YAML key — both top-level project entries AND nested sub-keys (`scm-github:`, `tracker:`, `agentConfig:`, `name:`, `path:`, etc.). On the real `~/.hermes/agent-orchestrator.yaml` (10 actual projects) it returns **48** — every nested key under any section. In the TDD Green phase this caused an over-warn: `10 scm: but 48 project(s)`.

**After (fixed):**
```bash
project_count=$(awk '
  BEGIN { in_projects=0; count=0 }
  /^projects:[[:space:]]*$/ { in_projects=1; next }
  in_projects && /^[^[:space:]]/ { in_projects=0 }
  in_projects && /^  [a-zA-Z][a-zA-Z0-9_-]*:[[:space:]]*(#.*)?$/ { count++ }
  END { print count+0 }
' "$cfg")
```

Anchors on the `projects:` section header; counts only entries at 2-space indent while `in_projects=1`. Returns **10** for the real config (correct).

### 3. Missing TDD Red phase for Phase 1/2 watchdog scripts

The PR body had the TDD cycle (`bash scripts/ao-doctor-v2.sh` Red, then Green) for the new `ao-doctor-v2.sh` script, but Phase 1 (`hermes-watchdog.sh` restored shim) and Phase 2 (`ai.agento.health-guardian.sh` new Tier 2) were presented as "PASS — script runs under launchd" with no Red capture of the broken initial state. This evidence bundle now provides the Red→Green narrative for both.

## Verification

```
$ bash -n scripts/ai.agento.health-guardian.sh && echo OK
OK
$ bash -n scripts/ao-doctor-v2.sh && echo OK
OK
$ bash -n /Users/jleechan/.hermes/scripts/hermes-watchdog.sh && echo OK
OK
$ bash scripts/ao-doctor-v2.sh   # Red phase (real staging config)
=== summary: 7 pass, 0 warn, 1 fail ===
$ HERMES_STAGING_CONFIG=/tmp/doctor-v2-test/staging-fixed.yaml bash scripts/ao-doctor-v2.sh  # Green phase
=== summary: 8 pass, 0 warn, 0 fail ===
$ bash scripts/ai.agento.health-guardian.sh
[ai.agento.health-guardian] all checks green (workers=8)
```

## Files

| File | Size | Purpose |
|------|------|---------|
| `cast.cast` | 5.4 KB | asciicast v2 raw |
| `cast.gif` | 2.1 MB | Animated GIF (solarized-dark, 14pt) |
| `cast.mp4` | 720 KB | MP4 (libx264, yuv420p, faststart) |
| `cast.vtt` | 1.4 KB | Caption track with 10 timed cues |
| `raw-typer.txt` | 4.3 KB | Raw `script -q` capture (input source) |
| `README.md` | this file | Documentation |

## Reproducibility

```bash
cd /Users/jleechan/.worktrees/agent-orchestrator/ao-6321
bash /tmp/skeptic-fixes-evidence.sh
# Then re-run the same `script -q` + `agg` + `ffmpeg` pipeline shown in
# skills/tmux-video-evidence/SKILL.md to regenerate the artifacts.
```
