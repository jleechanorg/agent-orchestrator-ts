# Nextsteps — Minimax 401 Harness Fix — 2026-05-01

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

- **Outcome:** Root cause of recurring MiniMax 401 auth failures in AO workers identified and fixed. The sed substitutions for `MINIMAX_API_KEY`, `MINIMAX_BASE_URL`, `MINIMAX_MODEL`, `MINIMAX_ANTHROPIC_BASE_URL` were missing from `setup-launchd.sh` — causing launchd to pass literal `@MINIMAX_API_KEY@` strings (expanded to empty by bash) to workers.
- **PR #510 merged** — added the sed substitutions and `AO_CLI_PATH`. **PR #512 created** — adds `@VAR@` fail-fast check to `test-launchd-env.sh`.
- **Skill updated** — `minimax-401-diagnostic/SKILL.md` now has Step 0 (check for `@VAR@` tokens before deeper diagnosis).
- **Beads**: None created — this was a one-session fix.
- **Next**: Get PR #512 merged, monitor that workers restart with correct env vars, update learnings.

---

## Context

Session started with ao-4449 worker stuck at `/login` with 401 error. Root cause: `setup-launchd.sh` missing 4 sed substitutions for MINIMAX env vars in `install_lifecycle_plist()`. The installed plist had literal `@MINIMAX_API_KEY@` which bash expanded to empty → 401 on every MiniMax API call.

**Why PR #510 "merged but never fixed it"**: PR #510 was APPROVED with all checks green but was never actually merged (merged: false). The branch `fix/lifecycle-launchd-ao-cli-path` had the correct fix. Session merged it manually (`gh pr merge 510`).

**Why the same pattern recurred**: Commit `893fae999` ("fix(launchd): propagate MINIMAX_API_KEY") only added the verification call, not the actual substitution lines — producing a misleading artifact that made it look fixed.

**Harness gap**: No validation step checked that `@VAR@` tokens were actually substituted after `setup-launchd.sh` ran.

---

## Bead index

| Bead | Title | Link |
|------|-------|------|
| None | — | — |

---

## Work queue

1. **Merge PR #512** — adds `@VAR@` fail-fast check to `test-launchd-env.sh`. This ensures the substitution gap is caught immediately, not after tmux inspection.
   - File: `scripts/test-launchd-env.sh`
   - Acceptance criteria: CI passes, check run green
   - Dependencies: None

2. **Verify workers restart with correct env** — confirm lifecycle-workers are picking up the real `MINIMAX_API_KEY` after the fix
   - Command: `ps eww -p $(pgrep -f lifecycle-worker | head -1) | tr ' ' '\n' | grep MINIMAX`
   - Expected: `MINIMAX_API_KEY=sk-cp-...` (real key, not empty, not `@MINIMAX_API_KEY@`)

3. **Kill stale ao-4449 session** — tmux pane was stuck on `/login`, restart fresh
   - Command: `tmux kill-session -t 953501c04ccc-ao-4449` (already done)

4. **Address PR #511** — KeepAlive:true on lifecycle-all was correctly flagged by all 3 CRs as causing 60-second kill/restart churn. The ao-4449 stall was actually the 401 bug (now fixed by #510), but the KeepAlive issue on lifecycle-all is real. PR #511 needs revision: revert `KeepAlive: true` on lifecycle-all, keep only on watchdog.

---

## PR / merge state

- [PR #510](https://github.com/jleechanorg/agent-orchestrator/pull/510): **MERGED** — sed substitutions for MINIMAX env vars + AO_CLI_PATH fix
- [PR #511](https://github.com/jleechanorg/agent-orchestrator/pull/511): **OPEN** — KeepAlive:true on lifecycle-all (needs revision per CR feedback)
- [PR #512](https://github.com/jleechanorg/agent-orchestrator/pull/512): **OPEN** — `@VAR@` fail-fast check in test-launchd-env.sh

---

## Learnings pointer

`~/roadmap/learnings-2026-05.md` — entry to be written

---

## Roadmap pointer

`roadmap/README.md` — Recent activity (rolling) section to be updated
