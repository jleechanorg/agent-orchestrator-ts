# Roadmap index (fork)

Design notes, audits, and rolling status for **jleechanorg/agent-orchestrator**. Upstream-facing docs live elsewhere; this folder is fork-first.

## Recent activity (rolling)

### 2026-04-08

- **Repo boundary (AO vs WorldAI)** — Keep orchestration code, plugins, workflows, scripts, tests, and policy-tracked evidence under **`docs/evidence/`** in **this** repo. Keep WorldAI product/runtime, campaigns, MCP integrations, and WA-specific evidence in the **WorldAI** repo. Local agent state (`~/.claude/`, `~/roadmap/`, mem0 hooks) stays out of git. Tracking: **bd-9nvf**.

### 2026-04-07

- **Video evidence roadmap** — Steps for Fix 2/3, captions, eloop monitoring: [`video-evidence-roadmap.md`](./video-evidence-roadmap.md) (epic bd-vide1).

### 2026-04-05

- **Skill restoration (bd-pwku)** — Archived loose-md skills restored to **`~/.claude/skills/<name>/SKILL.md`**; repo **`.claude/skills/README.md`** + **`CLAUDE.md`** pointers; duplicate loose files removed. Details: [`skill-restoration.md`](./skill-restoration.md). Pre-change roadmap snapshot: **`~/Downloads/agent-orchestrator-roadmap-*`**.
- **Session registry harness** — New initiative: align `ao session ls` / metadata **`[working]`** with **tmux + JSONL ground truth** so operators are not misled by idle panes. Doc: [`session-registry-harness.md`](./session-registry-harness.md). Bead: **bd-9gvm** (related: **bd-3h9**).
- **Evolve loop & policy** — Landed: healthy-cycle fast path + session budget ([PR #380](https://github.com/jleechanorg/agent-orchestrator/pull/380)); Phase 7 recap + Phase 8 idle auto-cancel ([PR #381](https://github.com/jleechanorg/agent-orchestrator/pull/381)); Zero-Framework Cognition (ZFC) section in CLAUDE.md ([PR #382](https://github.com/jleechanorg/agent-orchestrator/pull/382)).
- **Skeptic** — `claude --print` runs from `/tmp` to avoid project `CLAUDE.md` hooks skewing evaluation (commit `7a9890f9`).

### 2026-04-09

- **scm-github / claim-pr** — **`checkoutPR`** now uses **`git checkout -f <branch>`** after fetch so AO-managed bootstrap files (e.g. `.claude/metadata-updater.sh`, `AGENTS.md`) touched during worktree init cannot abort PR branch checkout. PR **#419 merged** (commit **`f1870507`**). Gap: `git fetch --force` still throws "refusing to fetch into branch...checked out at" BEFORE checkout runs — recovery only at checkout stage, not fetch stage. Bead: **bd-anxs** (fetch-stage self-heal).
- **AO spawn ops** — Empty **`~/.openclaw_prod/agent-orchestrator.yaml`** (`projects: {}`) breaks **`ao spawn`**; **`AO_CONFIG_PATH=~/agent-orchestrator.yaml`** restores **`agent-orchestrator`** project. **Ghost worktrees** (missing dir, locked registration) block claims — **`git worktree unlock` + `remove --force`** for stale **`ao-*`** paths, then **`git worktree prune`**.
- **modelByCli fix (PR #411 merged)** — `resolveAgentSelection` now correctly reads `defaults.modelByCli[agentName].model`, so `ao spawn --agent codex` uses **gpt-5-codex** instead of falling back to MiniMax-M2.7. Workers wa-258/wa-259 failed with MiniMax-M2.7 on Codex before this fix (commit `a52fc41e`).
- **Stuck-worker harness sweep** — Cross-repo triage of open **worldarchitect.ai** PRs found five AO-owned workers that were not actually doing useful work: PR **#6174 OPEN**, **#6172 OPEN**, **#6171 OPEN**, **#6166 OPEN**, **#6136 OPEN**. Failure classes split into blocked approval prompt, repeated **`Context limit reached`**, unsupported-model/session misroute, stale PR inference in **`ao status`**, and “baked/ready” panes still reported as working. New beads: **bd-8fhc**, **bd-alif**, **bd-ybkv**, **bd-5st6**. Related existing beads: **bd-9gvm**, **bd-22a6**.
- **Strict MCP config (PR #420)** — New **`--strict-mcp-config`** flag saves ~16k tokens per session. OPEN — needs review.
- **Open PR sweep** — Reviewed **16** open PRs; several **Evidence/Skeptic** reds with green **Test/Lint**; conflicting branches need **rebase**. Tracking: **bd-qaiz**.
- **PR #405** — 5 commits: novel daily runner (`run-daily.sh`, 256-line launchd AO spawner) + video evidence roadmap doc (`video-evidence-roadmap.md`, 103 lines, bd-vide1 epic). Branch clean.
- **Decisions (4)** — (1) **[#392](https://github.com/jleechanorg/agent-orchestrator/pull/392) merged** to `main` (evidence-gate Fix 2/3). (2) **[#415](https://github.com/jleechanorg/agent-orchestrator/pull/415) merged** (OpenClaw paths → `user-home-config-paths.ts`). (3) **[#419](https://github.com/jleechanorg/agent-orchestrator/pull/419) merged** (checkoutPR force checkout). (4) **Conflicts:** **[#409](https://github.com/jleechanorg/agent-orchestrator/pull/409) closed**; **[#413](https://github.com/jleechanorg/agent-orchestrator/pull/413)** rebase with main-first on shell files; **[#394](https://github.com/jleechanorg/agent-orchestrator/pull/394)** rebase vs **#392**; **[#389](https://github.com/jleechanorg/agent-orchestrator/pull/389)** doc rebase when ready; **[#395](https://github.com/jleechanorg/agent-orchestrator/pull/395)** defer to **[#399](https://github.com/jleechanorg/agent-orchestrator/pull/399)** for Gemini.
- **Harness (/harness)** — Root issue: **policy gates** (Evidence, Skeptic 6-green) fail independently of **compile/test** CI, and **two workflows** reuse the same check name **Skeptic Gate** (`skeptic-gate.yml` vs `test.yml`), which looks like flaky CI. Mitigations: **`.github/pull_request_template.md`** preloads `## Evidence` + claim class (reduces Evidence Gate failures); follow-up: rename poll job / fix `test.yml` escaping, sync `skeptic-cron` jq. Bead: **bd-kkiq** (dedupe Skeptic check names + repair `test.yml`).
- **jleechanclaw AO recovery** — The "disabled" diagnosis was false: launchd label **`ai.openclaw.schedule.ao7green-jleechanclaw`** was enabled, but its wrapper died before startup because **`~/.bash_profile`** was sourced under **`set -u`** and hit unset interactive-only vars. After safe bootstrap, the real blocker surfaced in AO logs: backfill for PR **#537** repeatedly failed with **`fatal: refusing to fetch into branch ... checked out at ... jc-1795-pr537`**. Detaching the stale worktree freed the branch lock and AO immediately claimed the PR again as session **`jc-1852`**. Tracking: **bd-anxs**, **bd-sphf**.
- **Backfill blocker surfacing + fetch self-heal** — Local **`scm-github`** now self-heals the fetch-stage **`refusing to fetch into branch ... checked out at ...`** failure by removing stale AO-managed worktrees with dead tmux sessions and retrying fetch once. Repo and live operator diagnostics now surface recent **`lifecycle.backfill.claim_failed`** reasons instead of flattening them to **UNCOVERED**: current live blocked PRs are **#389**, **#394**, and **#396** with **`Workspace has uncommitted changes`** during claim, while restart of the live `agent-orchestrator` lifecycle worker immediately reclaimed **PR #413** as session **`ao-4547`**. Tracking: **bd-anxs**, **bd-oog3**, **bd-68zl**.

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
| Video / tmux evidence path | [video-evidence-roadmap.md](./video-evidence-roadmap.md) |

## Beads

Canonical issue list: **`.beads/issues.jsonl`**. Use **`br`** to create/update/close issues.
