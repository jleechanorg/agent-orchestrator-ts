# Roadmap index (fork)

Design notes, audits, and rolling status for **jleechanorg/agent-orchestrator**. Upstream-facing docs live elsewhere; this folder is fork-first.

## Recent activity (rolling)

### 2026-04-09

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
