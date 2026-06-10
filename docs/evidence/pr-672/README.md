# PR #672 Evidence — doctor.sh v2 + Tier 2 watchdog-of-watchdogs

**Commit SHA:** `c6918fbbf1041e87bc510d06f8d69c10effccc1c`
**Captured:** 2026-06-10T10:23Z
**PR:** [#672](https://github.com/jleechanorg/agent-orchestrator/pull/672)

## Artifacts

| File | SHA256 | Size | Purpose |
|------|--------|------|---------|
| `doctor-v2.mp4` | (see checksum.txt) | 263KB | H.264 video of TDD Red-Green cycle |
| `doctor-v2.gif` | (see checksum.txt) | 224KB | Browser-friendly preview |
| `doctor-v2.vtt` | (see checksum.txt) | 1.2KB | WebVTT captions |
| `doctor-v2.cast` | (see checksum.txt) | 5.7KB | Asciicast v2 source (machine-parseable) |

## GitHub-hosted URLs

- MP4: <https://github.com/jleechanorg/agent-orchestrator/releases/download/evidence-pr-672/doctor-v2.mp4>
- GIF: <https://github.com/jleechanorg/agent-orchestrator/releases/download/evidence-pr-672/doctor-v2.gif>
- VTT: <https://github.com/jleechanorg/agent-orchestrator/releases/download/evidence-pr-672/doctor-v2.vtt>
- Cast: <https://github.com/jleechanorg/agent-orchestrator/releases/download/evidence-pr-672/doctor-v2.cast>
- Bundle ZIP: <https://github.com/jleechanorg/agent-orchestrator/releases/download/evidence-pr-672/doctor-v2-evidence.zip>
- Release: <https://github.com/jleechanorg/agent-orchestrator/releases/tag/evidence-pr-672>

## Sections recorded

| # | Section | Duration | What it shows |
|---|---------|----------|---------------|
| 1 | Git Provenance | 10s | HEAD, branch, merge-base, commits-ahead |
| 2 | Commit Log | 10s | All 6 commits in this PR (since main) |
| 3 | Diff Stat | 10s | 5 files, +781 LOC |
| 4 | PR Status | 10s | gh pr view — headRefOid, reviewDecision, mergeable |
| 5a | Tier 1 hermes-watchdog | 15s | launchctl state + last log line (dedup working) |
| 5b | Tier 2 health-guardian | 15s | launchctl state + last log line (all checks green) |
| 5c | Tier 1 ai.agento.health | 15s | launchctl state (interval job, not running between cycles) |
| 5d | TDD Red phase | 20s | `bash scripts/ao-doctor-v2.sh` — exits 1 with staging-config FAIL |
| 5e | TDD Green phase | 20s | `HERMES_STAGING_CONFIG=…` — exits 0 with all 8 PASS |
| 6 | Post-run SHA | 10s | Same SHA = c6918fbbf (proves no scope creep) |

## How to reproduce

```bash
# TDD Red phase
cd /Users/jleechan/.worktrees/agent-orchestrator/ao-6321
bash scripts/ao-doctor-v2.sh
# Expected: exits 1; one FAIL: "staging config has NO 'scm:' field"

# TDD Green phase
HERMES_STAGING_CONFIG=/tmp/doctor-v2-test/staging-fixed.yaml bash scripts/ao-doctor-v2.sh
# Expected: exits 0; all 8 PASS
```

## Self-verification

The video shows the same SHA at the start (Section 1) and end (Section 6). If they
diverge, the recording captured scope creep and the evidence is invalid.
