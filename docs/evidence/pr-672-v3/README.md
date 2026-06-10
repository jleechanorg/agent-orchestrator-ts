# PR #672 TDD Red→Green for all 6 doctor-v2 checks (head `751d10fcc`)

**Captured:** 2026-06-10 04:11 UTC
**PR:** [jleechanorg/agent-orchestrator#672](https://github.com/jleechanorg/agent-orchestrator/pull/672)
**Head commit:** `751d10fcc [agento] docs(evidence): add Skeptic-fix evidence bundle for PR #672`

## Why this evidence

A Skeptic verdict on `329894c9a` (and the subsequent re-evaluations) flagged
**Gate 8a FAIL — Goal 3 has 5/6 checks without Red-Green demonstration**.
The first evidence bundle (`pr-672/`) showed TDD Red→Green for `check_scm_config_in_staging`
only. This bundle completes the cycle for the remaining 5 checks.

## The 6 doctor-v2 checks (all in `scripts/ao-doctor-v2.sh`)

| # | Function | RED phase | GREEN phase |
|---|----------|-----------|-------------|
| 1 | `check_scm_config_in_staging` | Real `~/.hermes/agent-orchestrator.yaml` has 0 `scm:` | Test config with 10/10 `scm:` coverage |
| 2 | `check_skeptic_age_filter_order` | Pre-`ac2207e1e` filter at L276 ran before trigger check (bd-rgk0) | Post-PR #661: trigger @ L97 first, dedup @ L226 after |
| 3 | `check_gh_token_not_redacted` | `AO_BOT_GH_TOKEN=__OPENCLAW_REDACTED__` → 401 | Real `ghp_` token (length=40) |
| 4 | `check_dist_md5_match` | Source dist corrupted (md5 mismatch) | Source == binary md5 |
| 5 | `check_running_json_present` | `~/.agent-orchestrator/running.json` missing | File present |
| 6 | `check_watchdog_chain` | `ai.agento.health` bootout (deregistered) | All 3 plists registered |

## How to reproduce

```bash
cd /Users/jleechan/.worktrees/agent-orchestrator/ao-6321
bash /tmp/tdd-all-checks.sh
```

## Files

| File | Size | Purpose |
|------|------|---------|
| `cast.cast` | 6.2 KB | asciicast v2 raw |
| `cast.gif` | 2.8 MB | Animated GIF (solarized-dark, 13pt) |
| `cast.mp4` | 540 KB | MP4 (libx264, yuv420p, faststart) |
| `cast.vtt` | 1.0 KB | Caption track with 7 timed cues |
| `raw-typer.txt` | 4.2 KB | Raw `script -q` capture (input source) |
| `README.md` | this file | Documentation |
