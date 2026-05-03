# Nextsteps — Launchd Paranoid Audit Fixes — 2026-05-02

## Table of contents

- [Executive summary](#executive-summary)
- [Context](#context)
- [Bead index](#bead-index)
- [Work queue](#work-queue)
- [PR / merge state](#pr--merge-state)
- [Learnings pointer](#learnings-pointer)
- [Roadmap pointer](#roadmap-pointer)

---

## Executive summary

- **Outcome:** Paranoid audit of `setup-launchd.sh`, `start-all.sh`, and `test-launchd-env.sh` identified 7 issues (5 MAJOR, 2 MINOR) that need non-harness fixes. These are robustness gaps in the launchd bootstrap and verification scripts.
- **All items NEW** — no existing PRs cover these fixes.
- **Beads to be created** for each MAJOR fix to allow independent tracking.
- **Next**: Create beads for MAJOR items, implement fixes in a single PR or per-item based on scope, get merged.

---

## Context

Paranoid audit of launchd bootstrap scripts after the MiniMax 401 incident (PR #510/#512). The audit checked for patterns that could silently degrade despite a green harness run:

| Severity | File:Line | Issue | Risk |
|----------|-----------|-------|------|
| MAJOR | `setup-launchd.sh:43-51` | `command -v ao` resolves npm global not source-tree; no verification that npm matches source-tree | Fork commands in workers silently use wrong binary |
| MAJOR | `setup-launchd.sh:20-24` | Hardcoded fallback repo path `/Users/jleechan/project_agento/agent-orchestrator` | Breaks on any non-primary-machine setup |
| MAJOR | `test-launchd-env.sh:66` | Hardcoded key substring `sk-cp-Rg64`; check validates exact value not non-empty | Test passes only on specific key, false PASS on others |
| MAJOR | `test-launchd-env.sh:46` | `GITHUB_TOKEN` check only validates `ghp_` prefix; no format validation | Invalid token format passes as valid |
| MAJOR | `test-launchd-env.sh:32-34` | Highest PID ≠ youngest process; process start time needed | Wrong process selected for verification on busy host |
| MINOR | `start-all.sh:16` | `"ao"` fallback silently relies on PATH with no warning | Undebuggable if `ao` absent from PATH |
| MINOR | `setup-launchd.sh:79-85` | `bootout || true` silently ignores failures | Stale plist left running, new config never applied |

---

## Bead index

| Bead | Title | Link |
|------|-------|------|
| bd-lnch-01 | Verify source-tree ao binary matches npm link | (create) |
| bd-lnch-02 | Dynamic repo path in setup-launchd.sh | (create) |
| bd-lnch-03 | Replace hardcoded key check with non-empty validation | (create) |
| bd-lnch-04 | Add GITHUB_TOKEN format validation | (create) |
| bd-lnch-05 | Use process start time instead of highest PID | (create) |
| bd-lnch-06 | Warn if `command -v ao` fails in start-all.sh | (create) |
| bd-lnch-07 | Log warning on bootout failure instead of silent ignore | (create) |

---

## Work queue

### MAJOR

1. **`bd-lnch-01` — Verify source-tree ao binary matches npm link** (`setup-launchd.sh:43-51`)
   - File: `scripts/setup-launchd.sh`
   - Problem: `command -v ao` resolves the global npm prefix, not the source-tree binary at `packages/cli/dist/index.js`. Workers calling `execFile("ao", ...)` internally get the npm binary which lacks fork subcommands.
   - Fix: Add a verification step after `npm link` that compares the resolved `ao` path against the expected source-tree path. Fail with a clear error if they diverge.
   - Acceptance criteria: `bash scripts/setup.sh` exits with error if `command -v ao` != source-tree CLI path

2. **`bd-lnch-02` — Dynamic repo path in setup-launchd.sh** (`setup-launchd.sh:20-24`)
   - File: `scripts/setup-launchd.sh`
   - Problem: Hardcoded fallback `/Users/jleechan/project_agento/agent-orchestrator` breaks on any non-primary machine or worktree path
   - Fix: Derive the repo path dynamically using `git rev-parse --show-toplevel` when the explicit path is not provided. If not in a git repo, exit with a clear error requiring explicit path.
   - Acceptance criteria: Script works from any clone/worktree location without modification

3. **`bd-lnch-03` — Replace hardcoded key check with non-empty validation** (`test-launchd-env.sh:66`)
   - File: `scripts/test-launchd-env.sh`
   - Problem: Check looks for exact substring `sk-cp-Rg64` which passes only on one specific key value; any other valid key fails the check
   - Fix: Change to verify the key is non-empty and has valid token format (starts with expected prefix), without hardcoding the actual secret value
   - Acceptance criteria: Any non-empty `MINIMAX_API_KEY` passes; empty key fails

4. **`bd-lnch-04` — Add GITHUB_TOKEN format validation** (`test-launchd-env.sh:46`)
   - File: `scripts/test-launchd-env.sh`
   - Problem: `GITHUB_TOKEN` check only validates `ghp_` prefix; does not check token length, character validity, or structure
   - Fix: Add format validation (length check, expected character classes) as a secondary check after the prefix match
   - Acceptance criteria: Tokens failing format requirements produce a clear error, not a silent PASS

5. **`bd-lnch-05` — Use process start time instead of highest PID** (`test-launchd-env.sh:32-34`)
   - File: `scripts/test-launchd-env.sh`
   - Problem: `ps -p $(sort -t: -k2 -n | tail -1 | cut -d: -f1)` selects by highest PID (newest pid), not youngest process (earliest start time). On a busy host, PID ordering ≠ process age ordering.
   - Fix: Use `ps -p $PID -o lstart=` or `ps -p $PID -o etime=` to get actual start time; select by earliest start time
   - Acceptance criteria: On a system with 100+ processes, the correct (youngest by start time) lifecycle-worker is selected

### MINOR

6. **`bd-lnch-06` — Warn if `command -v ao` fails in start-all.sh** (`start-all.sh:16`)
   - File: `scripts/start-all.sh`
   - Problem: `"ao"` fallback silently relies on PATH; if `ao` is absent, workers spawn with a broken binary and fail undebuggably
   - Fix: Check `command -v ao` before spawning; emit a warning to stderr if not found, but do not hard-fail (to preserve existing behavior for environments where ao is on PATH)
   - Acceptance criteria: Missing `ao` produces a visible warning in output

7. **`bd-lnch-07` — Log warning on bootout failure instead of silent ignore** (`setup-launchd.sh:79-85`)
   - File: `scripts/setup-launchd.sh`
   - Problem: `bootout || true` swallows all failures; a stale plist left running means the new config is never loaded
   - Fix: Replace `|| true` with error logging; capture bootout exit code and emit warning with the label that failed
   - Acceptance criteria: Failed bootout produces a warning with the plist label, not silent success

---

## PR / merge state

All items are **NEW** — no existing PRs. Intent is to file one PR covering all 7 items, or split by severity if warranted.

| # | Bead | Status | Notes |
|---|------|--------|-------|
| — | bd-lnch-01 through bd-lnch-07 | NEW | No PRs yet |

---

## Learnings pointer

`~/roadmap/learnings-2026-05.md` — entry to be written after these fixes merge

---

## Roadmap pointer

`roadmap/README.md` — Recent activity (rolling) section to be updated