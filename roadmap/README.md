# Roadmap index (fork)

Design notes, audits, and rolling status for **jleechanorg/agent-orchestrator**. Upstream-facing docs live elsewhere; this folder is fork-first.

## Recent activity (rolling)

### 2026-05-20

- **PR #570: ci.yml OOM recovery fix** — `.github/workflows/ci.yml` OOM recovery (exit 137) accepts zero-failure Vitest summary as success. Added `PASSED -gt 0` and `FAILED` missing guards: when `grep -oP '\d+(?= passed)'` returns empty or zero, exits 1 (possible truncation); when `grep -oP '\d+(?= failed)'` returns empty, exits 1 (possible truncation). Resolves CR P2 threads (lines 165-166). Branch: `fix-openw-worker-reliability-v2`, head `d0cc653a3`.
- **PR #568: integration tests fixed** — pr568-worker subagent fixed integration test assertions to match simplified `opencode run` command format. Removed `exec opencode --session` expectations, updated `--model`/`--agent` argument order.
- **lifecycle-worker restart** — `ERR_MODULE_NOT_FOUND` on `@jleechanorg/ao-plugin-agent-opencode` after source build. Fixed: rebuilt plugin, confirmed lifecycle-worker takes positional arg (not `--project` flag). Restart command: `ao lifecycle-worker agent-orchestrator`.
- **PR #565 CONFLICTING** — `feat/bd-h44x-upstream-merge` still has merge conflicts. assess agent running.

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
