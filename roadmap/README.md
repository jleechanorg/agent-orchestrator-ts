# Roadmap index (fork)

Design notes, audits, and rolling status for **jleechanorg/agent-orchestrator**. Upstream-facing docs live elsewhere; this folder is fork-first.

## Recent activity (rolling)

### 2026-06-09 — Skeptic chain decoupling (three chapters)

- **PR [#654](https://github.com/jleechanorg/agent-orchestrator/pull/654) MERGED** — skepticModel list fallback + minimax/agy. **Unintentionally introduced `eligiblePRs` 24h age filter** at top of `runLocalSkepticCron` — this is the runtime coupling that caused the worldarchitect fleet-wide skeptic silence (rev-itrz9). The 251 `lifecycle.backfill.disabled_with_open_prs` warnings were operational noise; the actual cause was a fresh `/skeptic` trigger being silently dropped on a stale PR.
- **PR [#661](https://github.com/jleechanorg/agent-orchestrator/pull/661) OPEN** — `fix(bd-rgk0)`: re-decouples skeptic cron from PR recency. 9 commits on `fix/bd-rgk0-skeptic-cron-trigger-age-filter`, head `1a9767f55`, +360/-34, `mergeable: MERGEABLE`, `reviewDecision: REVIEW_REQUIRED`. Awaiting: Test, Green Gate, Skeptic Gate. The fix: comments checked first via `scm.listPRComments`; 24h filter is a fallback only when the SCM comment API is missing.
- **PR [#662](https://github.com/jleechanorg/agent-orchestrator/pull/662) OPEN** — `fix(bd-a7mq)`: session-manager reuse path honors `NON_RESTORABLE_STATUSES`.
- **PR [#663](https://github.com/jleechanorg/agent-orchestrator/pull/663) CLOSED** 2026-06-09T22:26:18Z (closed-not-merged) — user closed in favor of [PR #665](https://github.com/jleechanorg/agent-orchestrator/pull/665) (replacement with opt-in propagation whitelist).
- **Three-chapter history**: PR #497 (2026-04-27) decoupled call site at `lifecycle-manager.ts:2799`; PR #654 (2026-06-09) reintroduced coupling via `eligiblePRs` filter; PR #661 (OPEN) re-decouples. Lesson: decoupling must be verified at the call site AND every filter inside the called function.
- **Beads**: [bd-rgk0](https://github.com/jleechanorg/agent-orchestrator/pull/661) (P0), [bd-a7mq](https://github.com/jleechanorg/agent-orchestrator/pull/662) (P1), [bd-q3tt](https://github.com/jleechanorg/agent-orchestrator/pull/665) (P1 — closed-via-#665)
- **Nextsteps doc**: `nextsteps-2026-06-09-skeptic-decoupling-proof.md`

### 2026-06-04

- **Dark-factory deletion investigation** — Reported deletion of `~/projects/dark-factory` was a false alarm; repo intact (HEAD `49c2276`). Root cause of May 29 incident confirmed: AO lifecycle worker `pruneStaleWorktrees` deleted `~/projects/worldarchitect.ai` because `wa-orchestrator` session config had `worktree == path` (main clone treated as stale worktree).
  - **Context & Diagnostics**: In Pass 2 of worktree pruning, dead/killed sessions referencing the project root path as their `worktree` were targeted for cleanup. Due to a path comparison mismatch caused by resolved vs unresolved symlinks (e.g., `/var/folders/` vs `/private/var/folders/` on macOS), the safety check in `pruneStaleWorktrees` failed to identify the path as the main project directory.
  - **Fix Implementation**: [PR #647](https://github.com/jleechanorg/agent-orchestrator/pull/647) was merged to implement initial protection, but a gap remained where Pass 2 was closed without merge in [PR #642](https://github.com/jleechanorg/agent-orchestrator/pull/642). The full resolution is verified and protected by regression tests added in [PR #652](https://github.com/jleechanorg/agent-orchestrator/pull/652).
  - **Evidence Links**:
    - **TDD Red-Phase Failure**: [Red-Phase Test Log](https://gist.github.com/jleechanao/0cae7dc9f2706a4c466fa042b28e63ce) showing deletion risk of the main directory on unresolved symlink mismatch.
    - **TDD Green-Phase Pass**: [Green-Phase Test Log](https://gist.github.com/jleechanao/0cae7dc9f2706a4c466fa042b28e63ce) showing 12/12 successful worktree prune tests passing, protecting both resolved and unresolved paths.
    - **Incident Context**: See [session-manager.ts](../packages/core/src/session-manager.ts) and [session-manager-prune-stale-worktrees.test.ts](../packages/core/src/__tests__/session-manager-prune-stale-worktrees.test.ts) for implementation details.
  - **Related**: [bd-diq], [bd-48z]

### 2026-05-29

- **PR #640 OPEN — robust CLI update sync & rebuild** — 8 commits on `fix/robust-cli-update-sync-rebuild`: robust `ao-update.sh` root resolution (ported from upstream), antigravity as default agent in config schema, `noServer` WS fix for onboarding TypeError. Formatting mismatches and review threads fully resolved recursively — **Evidence Gate** and **CodeRabbit** are now **🟢 SUCCESS**. Waiting for explicit user merge approval. Bead [bd-us56](https://github.com/jleechanorg/agent-orchestrator/issues/646) successfully closed.
- **Upstream sync Phase 5 complete** — 34 PRs merged (#596–#639), 1,274 upstream commits audited. All MUST/HIGH/DEFER items integrated. Upstream sync epics: bd-qor4, bd-e228, bd-ykk1, bd-lbgc.

### 2026-05-18

- **PR #568 OPEN — opencode JSON pipeline + CI OOM fixes** — 15 commits on `fix/opencode-json-pipeline`: `singleThread` serialization for CLI OOM, file-capture before kill, exit-137 graceful handling, agent-opencode plugin rewrite eliminating hanging shell-pipe JSON loop (bd-vqd3), skeptic bugbot gate 4 fix. Priority: land this first.
- **P0 governance holes** — bd-io8q: main branch has zero protection (any merge allowed). bd-vpzh: 7 PRs merged without CR APPROVED. bd-866a: merge-gate passes on VERDICT=SKIPPED. Fix order: #568 → skeptic gate (#563) → merge-gate fail-open → branch protection.
- **5 PRs all OPEN** — #568 (opencode JSON), #569 (AO_CLI_PATH), #566 (openw reliability), #565 (upstream merge), #563 (PR561 threads).

### 2026-05-01

- **MiniMax 401 root cause fixed** — `setup-launchd.sh` was missing sed substitutions for `MINIMAX_API_KEY`, `MINIMAX_BASE_URL`, `MINIMAX_MODEL`, `MINIMAX_ANTHROPIC_BASE_URL` in `install_lifecycle_plist()`. Installed plist had literal `@MINIMAX_API_KEY@` strings → bash expanded to empty → 401 on every MiniMax API call → `/login` stall. PR **#510 MERGED** (sed substitutions + AO_CLI_PATH). PR **#512 OPEN** (fail-fast `@VAR@` check in `test-launchd-env.sh`). Skill `minimax-401-diagnostic/SKILL.md` updated with Step 0. Pattern recurred 6+ times — harness fix: `@VAR@` check added to test script.
- **PR #511 still open** — KeepAlive:true on lifecycle-all correctly flagged by all 3 CRs as causing 60-second kill/restart churn loop. PR needs revision: revert `KeepAlive: true` on lifecycle-all, keep only on watchdog.

### 2026-04-25

- **ao-core global dist stale — enum mismatch** — Global npm `@jleechanorg/ao-core@0.1.0` dist (built 08:04) missing `skeptic-review`, `respawn-for-review`, `claim-verification` from `ReactionConfigSchema.action` enum. Source dist (built 10:38) has all 8 values. Workers crashed with `ZodError: Invalid enum value 'skeptic-review'`. Fix: synced key files (config.js, lifecycle-manager.js, skeptic-reviewer.js, fork-skeptic-extension.js, index.js, worktree-git.js) from source to global npm location. Workaround: workers running from source `packages/cli/dist` (PID 3035 agent-orchestrator, PID 77098 worldarchitect).
- **SLACK_WEBHOOK_URL placeholder crash** — Global `ao-core/dist/utils.js` `validateUrl` throws on `${SLACK_WEBHOOK_URL:-https://hooks.slack.com/services/PLACEHOLDER}`. Source handles gracefully via `[notifier-slack] Ignoring unresolved webhookUrl placeholder`. Still unresolved — fix needed in `utils.js` validateUrl. Beads: **bd-2wdq**.
- **worldarchitect skeptic-cron disabled by backfillAllPRs=false** — `runLocalSkepticCron` gated by `backfillAllPRs !== false` at lifecycle-manager.ts:2765. worldarchitect had this false, silently skipping all skeptic evaluations. Fix: set `backfillAllPRs: true` in `~/.hermes_prod/agent-orchestrator.yaml`. Bead: **bd-fixsk**.
- **PR #500 ready to land** — `fix(skeptic): patchComment 404 fallback` supersedes #479. Verify workers spawning AO sessions, then land in order: #500 → rebase #495/#496/#498.

### 2026-04-22

- **Plugin refactor plan (bd-8kel)** — Fork has ~2,700 LOC of fork-specific code embedded in core files causing merge conflicts on every upstream import. Full architectural analysis: companion module pattern (`fork-*.ts`) already in use, all extractable as proper plugins. Designed 8-plugin architecture reducing conflict surface from ~2,700 to ~80 LOC. Plan: [`nextsteps-plugin-refactor.md`](./nextsteps-plugin-refactor.md). Phase 1: extract `lifecycle-skeptic` plugin (~500 LOC, highest impact).
- **Zero upstream commits merge cleanly** — Tested all 38+ MUST-HAVE upstream commits against both `upstream/main` and `worktree_upstream`. Only `034de8a3` (branch validation, 2 files) merged cleanly to upstream/main. All others had content or modify/delete conflicts. Structural divergence too deep for simple cherry-pick. Long-term fix: plugin refactor. Short-term: sequential conflict resolution workers.
- **Non-conflicting restructure (parallel path)** — [`nextsteps-non-conflicting-restructure.md`](./nextsteps-non-conflicting-restructure.md) identifies the "companion-first, plugin-second" path: fork-*.ts companion files are zero-conflict (new files), config-driven behavior merges cleanly, new plugin packages are zero-conflict. Audit Phase A: classify 11 fork-*.ts files into upstream-worthy / fork-only / inline-extract candidates.

### 2026-04-21

- **scm-github / claim-pr** — **`checkoutPR`** now uses **`git checkout -f <branch>`** after fetch so AO-managed bootstrap files (e.g. `.claude/metadata-updater.sh`, `AGENTS.md`) touched during worktree init cannot abort PR branch checkout. PR **#419 merged** (commit **`f1870507`**). Gap: `git fetch --force` still throws "refusing to fetch into branch...checked out at" BEFORE checkout runs — recovery only at checkout stage, not fetch stage. Bead: **bd-anxs** (fetch-stage self-heal).
- **AO spawn ops** — Empty **`~/.openclaw_prod/agent-orchestrator.yaml`** (`projects: {}`) breaks **`ao spawn`**; **`AO_CONFIG_PATH=~/agent-orchestrator.yaml`** restores **`agent-orchestrator`** project. **Ghost worktrees** (missing dir, locked registration) block claims — **`git worktree unlock` + `remove --force`** for stale **`ao-*`** paths, then **`git worktree prune`**.
- **modelByCli fix (PR #411 merged)** — `resolveAgentSelection` now correctly reads `defaults.modelByCli[agentName].model`, so `ao spawn --agent codex` uses **gpt-5-codex** instead of falling back to MiniMax-M2.7. Workers wa-258/wa-259 failed with MiniMax-M2.7 on Codex before this fix (commit `a52fc41e`).
- **Stuck-worker harness sweep** — Cross-repo triage of open **worldarchitect.ai** PRs found five AO-owned workers that were not actually doing useful work: PR **#6174 OPEN**, **#6172 OPEN**, **#6171 OPEN**, **#6166 OPEN**, **#6136 OPEN**. Failure classes split into blocked approval prompt, repeated **`Context limit reached`**, unsupported-model/session misroute, stale PR inference in **`ao status`**, and “baked/ready”
- **Skill restoration (bd-pwku)** — Archived loose-md skills restored to **`~/.claude/skills/<name>/SKILL.md`**; repo **`.claude/skills/README.md`** + **`CLAUDE.md`** pointers; duplicate loose files removed. Details: [`skill-restoration.md`](./skill-restoration.md). Pre-change roadmap snapshot: **`~/Downloads/agent-orchestrator-roadmap-*`**.
- **Session registry harness** — New initiative: align `ao session ls` / metadata **`[working]`** with **tmux + JSONL ground truth** so operators are not misled by idle panes. Doc: [`session-registry-harness.md`](./session-registry-harness.md). Bead: **bd-9gvm** (related: **bd-3h9**).
- **Evolve loop & policy** — Landed: healthy-cycle fast path + session budget ([PR #380](https://github.com/jleechanorg/agent-orchestrator/pull/380)); Phase 7 recap + Phase 8 idle auto-cancel ([PR #381](https://github.com/jleechanorg/agent-orchestrator/pull/381)); Zero-Framework Cognition (ZFC) section in CLAUDE.md ([PR #382](https://github.com/jleechanorg/agent-orchestrator/pull/382)).
- **Skeptic** — `claude --print` runs from `/tmp` to avoid project `CLAUDE.md` hooks skewing evaluation (commit `7a9890f9`).

### 2026-04-08

- **Repo boundary (AO vs WorldAI)** — Keep orchestration code, plugins, workflows, scripts, tests, and policy-tracked evidence under **`docs/evidence/`** in **this** repo. Keep WorldAI product/runtime, campaigns, MCP integrations, and WA-specific evidence in the **WorldAI** repo. Local agent state (`~/.claude/`, `~/roadmap/`, mem0 hooks) stays out of git. Tracking: **bd-9nvf**.
