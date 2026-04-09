# Roadmap index (fork)

Design notes, audits, and rolling status for **jleechanorg/agent-orchestrator**. Upstream-facing docs live elsewhere; this folder is fork-first.

## Recent activity (rolling)

### 2026-04-05

- **Skill restoration (bd-pwku)** — Archived loose-md skills restored to **`~/.claude/skills/<name>/SKILL.md`**; repo **`.claude/skills/README.md`** + **`CLAUDE.md`** pointers; duplicate loose files removed. Details: [`skill-restoration.md`](./skill-restoration.md). Pre-change roadmap snapshot: **`~/Downloads/agent-orchestrator-roadmap-*`**.
- **Session registry harness** — New initiative: align `ao session ls` / metadata **`[working]`** with **tmux + JSONL ground truth** so operators are not misled by idle panes. Doc: [`session-registry-harness.md`](./session-registry-harness.md). Bead: **bd-9gvm** (related: **bd-3h9**).
- **Evolve loop & policy** — Landed: healthy-cycle fast path + session budget ([PR #380](https://github.com/jleechanorg/agent-orchestrator/pull/380)); Phase 7 recap + Phase 8 idle auto-cancel ([PR #381](https://github.com/jleechanorg/agent-orchestrator/pull/381)); Zero-Framework Cognition (ZFC) section in CLAUDE.md ([PR #382](https://github.com/jleechanorg/agent-orchestrator/pull/382)).
- **Skeptic** — `claude --print` runs from `/tmp` to avoid project `CLAUDE.md` hooks skewing evaluation (commit `7a9890f9`).

### 2026-04-08

- **Repo boundary (AO vs WorldAI)** — Keep orchestration code, plugins, workflows, scripts, tests, and policy-tracked evidence under **`docs/evidence/`** in **this** repo. Keep WorldAI product/runtime, campaigns, MCP integrations, and WA-specific evidence in the **WorldAI** repo. Local agent state (`~/.claude/`, `~/roadmap/`, mem0 hooks) stays out of git. Tracking: **bd-9nvf**.

### 2026-04-09

- **scm-github / claim-pr** — **`checkoutPR`** now uses **`git checkout -f <branch>`** after fetch so AO-managed bootstrap files (e.g. `.claude/metadata-updater.sh`) touched during worktree init cannot abort PR branch checkout. Local commit **`3b3471f5`** — cherry-pick to a branch when publishing. Use **`pnpm exec ao`** from repo root so the linked plugin build is used.
- **AO spawn ops** — Empty **`~/.openclaw_prod/agent-orchestrator.yaml`** (`projects: {}`) breaks **`ao spawn`**; **`AO_CONFIG_PATH=~/agent-orchestrator.yaml`** restores **`agent-orchestrator`** project. **Ghost worktrees** (missing dir, locked registration) block claims — **`git worktree unlock` + `remove --force`** for stale **`ao-*`** paths, then **`git worktree prune`**.
- **Worker coverage** — MiniMax (**`--agent minimax`**, Claude Code + MiniMax API) spawned for previously unclaimed PRs after clearing branch locks; all open fork PRs had AO sessions as of this pass (see `ao status -p agent-orchestrator`).
- **Open PR sweep** — Reviewed **16** open PRs; several **Evidence/Skeptic** reds with green **Test/Lint**; conflicting branches need **rebase**. Tracking: **bd-qaiz**.
- **Decisions (3)** — (1) **[#392](https://github.com/jleechanorg/agent-orchestrator/pull/392) merged** to `main` (evidence-gate Fix 2/3). (2) **[#415](https://github.com/jleechanorg/agent-orchestrator/pull/415)** squashed to one **`[agento]`** commit; OpenClaw paths moved to **`user-home-config-paths.ts`** so `config.ts` passes wholesome fork-isolation. (3) **Conflicts:** **[#409](https://github.com/jleechanorg/agent-orchestrator/pull/409) closed** (stale bot branch); **[#413](https://github.com/jleechanorg/agent-orchestrator/pull/413)** keep `config-topology` + bootstrap scripts — rebase with main-first on shell files (commented); **[#394](https://github.com/jleechanorg/agent-orchestrator/pull/394)** rebase vs **#392**; **[#389](https://github.com/jleechanorg/agent-orchestrator/pull/389)** doc rebase when ready; **[#395](https://github.com/jleechanorg/agent-orchestrator/pull/395)** defer to **[#399](https://github.com/jleechanorg/agent-orchestrator/pull/399)** for Gemini.
- **Harness (/harness)** — Root issue: **policy gates** (Evidence, Skeptic 6-green) fail independently of **compile/test** CI, and **two workflows** reuse the same check name **Skeptic Gate** (`skeptic-gate.yml` vs `test.yml`), which looks like flaky CI. Mitigations: **`.github/pull_request_template.md`** preloads `## Evidence` + claim class (reduces Evidence Gate failures); follow-up: rename poll job / fix `test.yml` escaping, sync `skeptic-cron` jq. Bead: **bd-kkiq** (dedupe Skeptic check names + repair `test.yml`).

### Older entries

See individual docs below; long-form evolve-loop cycles remain in [`evolve-loop-findings.md`](./evolve-loop-findings.md).

## Documents by theme

| Topic | File |
|--------|------|
| Skill restoration (user scope vs repo) | [skill-restoration.md](./skill-restoration.md) |
| Session / CLI observability harness | [session-registry-harness.md](./session-registry-harness.md) |
| Evolve loop history & metrics | [evolve-loop-findings.md](./evolve-loop-findings.md) |
| Skeptic + AO worker architecture | [skeptic-ao-worker-architecture.md](./skeptic-ao-worker-architecture.md) |
| Harness engineering (Ryan talk) | [harness-engineering-v2.md](./harness-engineering-v2.md) |
| Autonomy / green loop | [autonomy-gaps.md](./autonomy-gaps.md), [green-loop-e2e.md](./green-loop-e2e.md), [7green-enforcement-gaps.md](./7green-enforcement-gaps.md) |
| API / rate limits | [api-rate-limit-mitigation.md](./api-rate-limit-mitigation.md), [gh-api-reduction-validation.md](./gh-api-reduction-validation.md) |
| Next priority batch | [next-priority-fixes.md](./next-priority-fixes.md) |
| Multi-CLI / TDD roadmap | [autonomous-orchestrator-multi-cli-design.md](./autonomous-orchestrator-multi-cli-design.md), [tdd-bead-roadmap-autonomous-orchestrator.md](./tdd-bead-roadmap-autonomous-orchestrator.md) |
| Zero-touch rate | [zero-touch-6green-rate.md](./zero-touch-6green-rate.md) |

## Beads

Canonical issue list: **`.beads/issues.jsonl`**. Use **`br`** to create/update/close issues.
