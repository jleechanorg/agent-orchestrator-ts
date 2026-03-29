# Upstream Sync Review: ComposioHQ/agent-orchestrator

**Date**: 2026-03-28
**Fork**: jleechanorg/agent-orchestrator
**Branch**: `feat/upstream-sync-review-1274` (worktree: `ao-1274`)
**Upstream SHA**: `b1b32adb0f86134518ed04d74e589ad53da6049e`
**Origin SHA**: `b3d59e09d2385c4b556bb3ec5a0f09590d3e9beb`

## Divergence Summary

| Direction | Commits |
|---|---|
| Upstream (ComposioHQ) ahead of origin | ~477 (total); upstream advances daily — run `git rev-list --left-right --count upstream/main...origin/main` to get current count |
| Origin (jleechanorg) ahead of upstream | 17 commits (fork-specific) |
| Origin commits (last 30d) | 11 |

**The fork has ~200 commits from upstream that it does not have.** The fork diverged significantly months ago and has been developing independently.

---

## Origin/Fork-Specific Commits (not in upstream, last 30d)

These are the jleechanorg fork's unique contributions:

| SHA | Author | Message |
|---|---|---|
| `b3d59e0` | jleechan | chore: add P0 beads for skeptic gate gaps |
| `8db4ab0` | jleechan | fix: nuanced PR close policy + skeptic-gate improvements |
| `fc46876` | jleechan2015 | [agento] refactor(skeptic-gate): route skeptic via AO worker (no GHA API keys) |
| `05ba13d` | jleechan2015 | [agento] fix(lifecycle): isAlive probe bypasses grace period |
| `fe7fd91` | jleechan | fix(harness): PreToolUse hook blocking PR closure |
| `f916317` | jleechan2015 | [agento] feat: add verify6Green() pre-merge gate |
| `f519c22` | jleechan2015 | [agento] feat: cap send-to-agent retries at 3 + idempotency docs |
| `9e5d7be` | jleechan | docs: 7-green enforcement gaps audit + skeptic AO worker roadmap |
| `e16732a` | jleechan2015 | [agento] fix(design-doc): break regenerate-loop + strip CURSOR_SUMMARY |
| `d9ed9a4` | jleechan2015 | [agento] fix(backfill): recover repoDir, extract shared util |
| `bf84a42` | jleechan2015 | [agento] chore: improve metadata-updater hook |

---

## Upstream Commits (ComposioHQ/main, last 30 days = since 2026-02-26)

**Total: 346 commits** — massive activity across all areas.

---

## P0 — Cherry-pick Immediately (Security / Data Integrity)

### P0-A: `b49c69ba` — fix: gitleaks scan PR scope with fetch-depth opt + checksum (2026-03-27)
**PR**: #735 / `c487b409`
**Severity**: Security
**What**: Gitleaks scan now uses `fetch-depth: 50` (sufficient history without full clone) and verifies the binary's SHA256 checksum before use. The scan covers all file changes in the PR working tree via `gitleaks detect --source .`; the previous approach risked scanning a larger-than-necessary history.
**Adaptation**: Fork's `security.yml` gitleaks step adopted: (a) `fetch-depth: 50` for PR commits, (b) SHA256 checksum verification (fail-closed), (c) `head.sha` checkout for fork-PR safety.
**Risk**: Low — additive fix to CI config.

### P0-B: `70fe5369` — fix: use correct gitleaks --log-opts syntax with commit range (#721)
**PR**: #720 / `ff48b052`
**What**: Upstream corrected `--log-opts` syntax for gitleaks. Fork does not use `--log-opts` (uses `gitleaks detect --source .` working-tree scan instead, which is equivalent for PR-scoped changes with `fetch-depth: 50`).
**Related**: `f0bcb7b7` — replace gitleaks-action v2 with free CLI to fix org license error (#721)
**Risk**: Low — CI tooling fix.

### P0-C: `c975f952` — fix(core): mandate ao send and ban raw tmux (#340)
**What**: Upstream explicitly bans raw `tmux send-keys` in favor of `ao send`. This matches the fork's philosophy exactly. Upstream is ahead on this — the fork's `mandate-ao-send` work pre-dates this.
**Adaptation**: Fork already has agentRules discouraging raw tmux; verify whether core-level enforcement is needed. See CP-5 in cherry-pick table.
**Risk**: Medium — could conflict with fork's agentClaudeCode plugin hooks.
**Action**: **SKIP** — fork already covers this via agentRules; CP-5 addresses the remaining enforcement gap.

### P0-D: `91117f9e` / `c36440df` — ci: gitleaks checksum verification and optimize fetch-depth (#731, #732)
**What**: Upstream added SHA256 checksum verification for gitleaks binary download and optimized `fetch-depth: 0` to use actual PR SHA. Prevents supply-chain attacks on the gitleaks binary.
**Risk**: Low — additive CI hardening.

### P0-E: `59633e45` — fix(agent-claude-code): detect cd-prefixed gh/git commands and use relative hook path
**Date**: 2026-03-08
**What**: Agent sends `cd /some/path && gh pr ...` but git hooks are resolved relative to repo root. Upstream detects the `cd`-prefix and strips it before resolving hook paths.
**Relevance**: This is the EXACT bug the fork's `metadata-updater.sh` has! The `.claude/metadata-updater.sh` uses `$GIT_DIR/../.git` to reference hooks. If agents `cd` first, this path breaks.
**Action**: SKIP — already in fork (see CP-3 in Cherry-Pick Action Plan).
**Risk**: Low — isolated to hook path resolution.

---

## P1 — High Value, Review for Fork Fit

### P1-A: `f48c939d` — feat: lifecycle manager, backlog auto-claim, task decomposition, and verification gate (#365)
**Date**: 2026-03-10
**Author**: Harsh Batheja
**What**: **The upstream lifecycle manager** — adds backlog auto-claim, automatic task decomposition from tracker issues, and a verification gate (not the same as the fork's skeptic-gate, but related).
**Key features**:
- `backlogAutoClaim: true` — automatically claims open issues from tracker
- Task decomposition: splits large issues into sub-tasks
- Verification gate: runs checks before marking done
**Adaptation**: The fork has its OWN lifecycle manager (`packages/core/src/lifecycle-manager.ts`). These are potentially complementary but could conflict. **Do not cherry-pick** — instead evaluate which patterns to adapt into the fork's reaction system.
**Risk**: High conflict — both implement lifecycle management.

### P1-B: `4fd8cac7` — feat: add SCM webhook lifecycle triggers (#394)
**Date**: 2026-03-11
**Author**: Harsh Batheja
**What**: Adds GitHub webhooks (PR opened, push, PR merged, etc.) as lifecycle triggers INSTEAD OF polling. Dramatically reduces API calls.
**Relevance**: The fork's `getPendingComments` has GraphQL exhaustion issues (bd-o4t). Webhooks would bypass polling entirely.
**Adaptation**: High value for the fork's CI/reaction system. Investigate whether webhook receiver is a new plugin or part of core.
**Risk**: Medium — requires webhook endpoint registration.

### P1-C: `a64c051e` — fix(lifecycle): implement stuck detection using agent-stuck threshold (#376)
**Date**: 2026-03-13
**Author**: Joakim Sigvardt
**What**: Detects when an agent session is stuck (no progress for N minutes) using an `agent-stuck` threshold. Auto-kills and respawns.
**Relevance**: The fork has `session-reaper` and `stuck-agent` detection. Upstream's implementation uses a different approach (`lifecycleManager.stuckThresholdMs`). Compare implementations.
**Risk**: Medium — could conflict with fork's stuck detection.

### P1-D: `3d518aed` — feat: add doctor and update maintenance tooling (#437)
**Date**: 2026-03-12
**Author**: Harsh Batheja
**What**: `ao doctor` command — checks lifecycle worker health, detects common issues (orphan worktrees, zombie sessions, stale metadata).
**Relevance**: The fork has `ao doctor` in its CLI (`packages/cli/src/commands/doctor.ts`). Compare implementations.
**Risk**: Low — additive tooling.

### P1-E: `2eedb613` — refactor(core): decompose session-manager.test.ts into modular test files (#724)
**Date**: 2026-03-10
**What**: Test file restructuring — better coverage organization.
**Risk**: Low — tests only.

### P1-F: `b865549e` — fix(codex): harden gh wrapper resolution with explicit GH_PATH
**Date**: 2026-03-08
**What**: Codex plugin now uses explicit `GH_PATH` env var instead of relying on `which gh`.
**Relevance**: Fork's codex plugin may have similar issues. Check if fork's `agent-codex` plugin handles this.
**Risk**: Low.

### P1-G: `e5105133` — Default dangerouslySkipPermissions to true (#226)
**Date**: 2026-02-27
**Author**: prateek
**What**: Upstream defaults `dangerouslySkipPermissions` to `true` in the CLI.
**Relevance**: The fork ALREADY does this (it's in the origin/main commits). Confirm it matches upstream's implementation.
**Risk**: N/A — already in fork.

### P1-H: `5540d902` — fix: skip orchestrator sessions during cleanup (#144)
**Date**: 2026-02-27
**Author**: prateek
**What**: Lifecycle cleanup skips sessions marked as orchestrators (not regular workers).
**Relevance**: Fork has `skip-orchestrator` logic in session-reaper. Compare.
**Risk**: Low.

### P1-I: `91dd7cc1` — fix: keep Claude Code interactive after initial prompt (#145)
**Date**: 2026-02-27
**Author**: prateek
**What**: After Claude Code processes initial prompt, stays interactive for user input.
**Risk**: Low.

### P1-J: `dc85cdbe` — fix: fetch automated PR comments via explicit GET pagination (#447)
**Date**: 2026-03-12
**Author**: Harsh Batheja
**What**: Uses explicit pagination for fetching PR comments (not GraphQL cursor pagination).
**Relevance**: The fork has GraphQL exhaustion in `getPendingComments` (bd-o4t). REST pagination here is a model for the REST fallback.
**Risk**: Low — additive.

### P1-K: `5896181` — fix: assign 429 error to lastError so exhausted rate-limit throws immediately
**What**: Discord notifier (and other API calls) now throws immediately when rate limit is exhausted, rather than silently retrying forever.
**Relevance**: Matches the fork's `ghRestFallback` goal — fail fast on exhausted quota.
**Risk**: Low.

---

## P2 — Interesting but Fork-Irrelevant or High-Conflict

### P2-A: `b3ff0d9b` — feat(web): Project-scoped dashboard with sidebar navigation (#381)
**Date**: 2026-03-11
**What**: Major web dashboard redesign with per-project sidebar.
**Fork stance**: The fork does NOT maintain the web dashboard (that's ComposioHQ's product). **Skip.**

### P2-B: `36d354e0` — feat: OpenClaw plugin, AO skill, Discord notifier, and setup wizard
**Date**: 2026-03-23
**What**: OpenClaw integration (different from fork's MCP mail OpenClaw), Discord notifications.
**Fork stance**: Fork already has OpenClaw notifier via MCP mail. **Skip** — different integration.

### P2-C: `c5309992` — feat(mobile): add React Native app for monitoring AO sessions
**Date**: 2026-03-03
**What**: React Native mobile app.
**Fork stance**: Out of scope. **Skip.**

### P2-D: `38c35cd6` — feat: harden plugin, rewrite skill for ClawHub
**What**: Plugin system hardening for third-party plugin marketplace.
**Fork stance**: Fork's plugin system diverges. **Skip.**

### P2-E: `c490ff4b` — feat(core): add feedback tools contracts, validation, storage, and dedupe
**What**: Feedback collection infrastructure.
**Fork stance**: May overlap with fork's beads system. **Investigate** before deciding.

### P2-F: `88015028` — feat: add PR claim flow for agent sessions (#326)
**Date**: 2026-03-07
**What**: Agents can claim PRs automatically as they work.
**Relevance**: Fork has PR claiming in lifecycle-manager. Compare approaches.
**Risk**: Medium — could conflict.

### P2-G: `4e2144d9` — feat: OpenCode session lifecycle and CLI controls (#315)
**Date**: 2026-03-08
**What**: OpenCode agent (alternative to Claude Code) session management.
**Fork stance**: Fork focuses on Claude Code and Codex. OpenCode is not a priority. **Skip.**

### P2-H: `0d2804fc` / `3845bd58` / `ffef8d4a` — Mobile UX improvements
**What**: Mobile-first accordion layout, quick-replies, action strips.
**Fork stance**: Skip.

---

## P3 — Nice to Have / Reference Only

### P3-A: `aefa6ef0` — fix(core): enforce single-owner PR claim consolidation (#390)
**Date**: 2026-03-10
**What**: Prevents two workers from claiming the same PR simultaneously.
**Fork**: The fork's `claimPR` has this guard. Verify upstream's approach is compatible.

### P3-B: `ffae6718` — fix: pause workers on model limits and stabilize session visibility (#367)
**What**: Workers pause when model API returns 429 or rate limit.
**Fork**: Should be consistent with fork's rate limit handling.

### P3-C: `439b30fa` — fix: implement PR325 session capture fallback and spawn race hardening (#366)
**What**: Race condition hardening in spawn path.
**Fork**: Check if fork has equivalent guards.

### P3-D: `c8ba03bb` — fix: fail hard when --test-notify is set but config load fails
**What**: CLI validation improvement.
**Risk**: Low — additive.

### P3-E: `4622be19` — feat(web): add PWA support and mobile flawlessness fixes
**What**: Progressive web app support for the dashboard.
**Skip** (web dashboard out of scope).

### P3-F: `783b21dc` — feat(terminal): add Cmd+C/V and Ctrl+Shift+C/V clipboard shortcuts
**What**: Terminal clipboard improvements.
**Risk**: Low — additive.

---

## Cherry-Pick Action Plan

> **Status (2026-03-28):** origin/main is 12 commits AHEAD of upstream/main. The fork diverged months ago and has been developing independently. Cherry-picking upstream commits causes conflicts because both sides modified the same files. Key patches were **manually applied** as described below.

### Applied patches (2026-03-28)

| ID | File | What | Status |
|---|---|---|---|
| CP-1/2/6 | `.github/workflows/security.yml` | Gitleaks: SHA256 checksum + commit-range scan for PRs + fetch-depth opt | **APPLIED** |
| CP-3 | `packages/plugins/agent-claude-code/src/index.ts` | CD-prefix stripping in metadata-updater.sh | **SKIP — already in fork** |
| CP-4 | `packages/plugins/scm-github/` | REST pagination for PR comments | **PENDING — see bd-o4t** |
| CP-5 | `packages/plugins/agent-codex/src/index.ts` | GH_PATH env var in getEnvironment() | **SKIP — already in fork** |

**P0 gitleaks patch applied to `security.yml`:**
- `fetch-depth: 50` for sufficient history without full clone
- Added SHA256 checksum verification before extracting gitleaks binary (fail-closed)
- Added explicit `head.sha` + `persist-credentials: false` for PR checkout
- Combines upstream gitleaks security fixes from PRs #731, #732

### Evaluate before cherry-pick (medium risk / high value)

| Priority | SHA | Reason |
|---|---|---|
| EV-1 | `4fd8cac7` | SCM webhooks — could replace polling entirely (bd-o4t fix) |
| EV-2 | `dc85cdbe` | REST pagination for PR comments — model for bd-o4t REST fallback |
| EV-3 | `a64c051e` | Stuck detection — compare with fork's session-reaper |
| EV-4 | `3d518aed` | ao doctor — compare with fork's `packages/cli/src/commands/doctor.ts` |
| EV-5 | `f48c939d` | Lifecycle manager backlog/auto-claim — study patterns, do NOT cherry-pick |
| EV-6 | `c975f952` | Ban raw tmux — verify fork has equivalent core enforcement |

---

## Fork-Specific Patterns NOT in Upstream

The following fork innovations have no upstream equivalent (differential advantage):

| Feature | Commits | Value |
|---|---|---|
| Skeptic gate via AO worker (no GHA API keys) | `fc46876` | Eliminates CI secret management |
| verify6Green() pre-merge gate | `f916317` | Enforces 6-green before merge |
| PreToolUse hook blocking PR close | `fe7fd91` | Prevents accidental PR closures |
| send-to-agent retry cap (3x) | `f519c22` | Prevents context window burn |
| Startup grace period (isAlive bypass) | `05ba13d` | Fixes lifecycle startup race |
| Beads issue tracker | `.beads/` | Lightweight SQLite+JSONL tracking |

---

## Notes

- **Fork divergence is structural.** origin/main is 12 commits AHEAD of upstream/main. The fork diverged months ago and has been developing independently. Do NOT attempt broad cherry-picks — conflicts are expected.
- Cherry-pick strategy: identify specific commits, read their diffs, manually apply the relevant code patterns.
- The `roadmap/`, `.beads/`, `CLAUDE.md`, `AGENTS.md`, `.claude/` directories are fork-only — do NOT cherry-pick upstream versions.
- `packages/web/` (Next.js dashboard) and `packages/mobile/` (React Native) are completely out of scope for this fork.
- The gitleaks SHA256 checksum (`b46b083...`) was copied from upstream PR #721 for gitleaks 8.21.1 Linux x64 — verify against the official release page if needed.
