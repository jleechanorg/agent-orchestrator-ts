# CLAUDE.md — Agent Orchestrator Fork Guidelines

This file is read by Claude Code when working in this repository.

## Zero-Framework Cognition (ZFC)

**Core rule:** Never implement keyword routing, heuristic scoring, semantic analysis, or classification logic in application code. Delegate all such judgment to model API calls.

**AO-specific forbidden patterns:**
- Hardcoded intent/activity classifiers in plugin code (e.g., `if task.includes("fix")` to detect bug-fix tasks)
- New `detectActivity()` implementations using handcrafted regex routing — prefer model-based classification or simple process-state checks (is process running? is there recent output?); existing implementations should be flagged for future migration
- Hardcoded lists of "coding task keywords" in routing logic — flag existing such patterns for future migration to model call
- AO config classifiers (stuck detection, PR state routing) using keyword heuristics instead of model calls

**Correct pattern:** Pass the text/context to the model with a clear prompt, use the model's response as the decision. For activity detection, prefer simple process-state queries over semantic analysis.

**Shortcut:** If you catch yourself writing a ZFC violation, say "ZFC violation!" and refactor to model delegation.

**Exemptions:**
- Pure syntax parsing (lexing, parsing, type-checking)
- Deterministic transformation with no judgment calls
- Test fixtures with explicit expected outputs
- Config file path resolution, file existence checks, or process-state queries (is running? file exists?)

## Development Hierarchy

**Before writing any code, follow this order:**

| Priority | Approach | When to use |
|---|---|---|
| 1 | **Config** | Behavior expressible via `agent-orchestrator.yaml` (reactions, agentRules, routing) |
| 2 | **New plugin** (existing slot) | New runtime, agent, SCM, tracker, notifier, or workspace implementation |
| 3 | **New plugin type** (new slot) | Behavior that needs a new plugin slot in plugin-registry |
| 4 | **Core code change** | Only when 1–3 are genuinely insufficient — justify in PR |

Core code (`packages/core/src/`) should be treated as stable infrastructure. The vast majority of new capabilities should live in plugins. Roadmap docs, design notes, and fork-specific tooling config live in `roadmap/`, `.beads/`, and `CLAUDE.md` — these are first-class artifacts, not noise.

## AO Workers Are the Default Execution Model

**This is the most important operational principle in this repo.**

When given a task, **default to dispatching an AO worker** — not running `claude -p`, not opening a terminal yourself, not writing a one-off script.

### When to use AO workers
- Implementing features, bug fixes, or refactors
- Running tests, fixing CI failures
- Reviewing PRs, addressing review comments
- Investigating issues, reading logs, debugging
- Any coding task of more than a few lines
- Orchestrating multi-step workflows

### When to use CLI directly (`claude -p`, `claude --print`)
**Almost never.** Reserve direct CLI invocations for:
1. **Quick one-liners** — verifying a regex, checking a file diff, reading a config value
2. **Diagnostic commands** — `gh pr status`, `git log`, `grep`ing logs
3. **Setup/teardown** — bootstrapping a new worktree, cleaning up before an AO session starts
4. **When AO is genuinely unavailable** — tmux is down, the repo has no worktree set up, or AO's spawn path is broken

If the task involves writing code, opening a PR, running CI, or doing anything non-trivial — **dispatch an AO worker**. Never spend your own tokens on work an AO worker can do better and in parallel.

### AO workers are general-purpose — not PR-bound

AO workers are **sessions that run tasks**, not "sessions that claim PRs." A worker can:
- Work on a PR (via `ao spawn --claim-pr N`)
- Work on a bead or issue (via `ao spawn --bead <id>`)
- Work on an arbitrary task with no PR or bead (via `ao spawn "fix the rate limit handler in scm-github"`)
- Run a monitoring loop, cron job, or background task

Do not require an AO worker to claim a PR in order to be useful. If a PR exists for the work, the worker can claim it — but PR-bound worktree linkage is a detail, not the worker's identity.

### How to dispatch an AO worker

```bash
# General task — no PR required
ao spawn "fix the authentication bug in the Slack notifier"

# On a specific PR (creates worktree automatically)
ao spawn --project agent-orchestrator --claim-pr <N>

# On a bead
ao spawn --project agent-orchestrator --bead bd-xxx

# Monitor/loop task (long-running)
ao spawn --project agent-orchestrator --no-worktree "run the evolve loop"
```

Do not manually create worktrees, `cd` into directories, or run `claude` directly for tasks that belong to an AO worker.

## Skeptic Architecture — SETTLED DECISION (do not revisit)

**Skeptic evaluations run via AO worker (local API keys), NOT in GHA. Do NOT add API keys to CI.**

| Component | Role | Runs where |
|-----------|------|------------|
| `skeptic-gate.yml` | GHA check that polls for VERDICT comment | GHA (no API keys) |
| `skeptic-cron.yml` | Cron that evaluates open PRs | GHA — calls `ao skeptic verify` which needs local LLM |
| `ao skeptic verify` | CLI command that runs LLM evaluation | Local machine (has API keys via env/OAuth) |
| lifecycle-worker | Detects trigger comments, dispatches `ao skeptic verify` | Local machine (launchd plist) |

**The chain**: PR event → `skeptic-gate.yml` starts polling → lifecycle-worker detects PR → runs `ao skeptic verify` locally → posts VERDICT comment → `skeptic-gate.yml` sees VERDICT → exits PASS/FAIL.

**When skeptic is broken, the fix is ALWAYS in this chain:**
1. Is the lifecycle-worker running? (`launchctl print gui/$(id -u)/com.agentorchestrator.lifecycle-agent-orchestrator`)
2. Is the lifecycle-worker detecting PRs and dispatching skeptic? (check logs)
3. Is `ao skeptic verify` producing a VERDICT? (run manually: `ao skeptic verify -n <PR> --dry-run`)
4. Is the VERDICT being posted? (check PR comments for SKEPTIC_BOT_AUTHOR)
5. Is `skeptic-gate.yml` polling correctly? (check GHA run logs)

**Red flags — if you think any of these, STOP:**
- "Add ANTHROPIC_API_KEY to repo secrets" → WRONG
- "Install claude/codex in GHA runner" → WRONG
- "Make skeptic-cron run the LLM in GHA" → WRONG
- The answer is: fix the AO worker chain above.

## LLM Evaluation — Shared Utility

**All LLM evaluation (skeptic, verifier, exit-criteria checks) MUST route through `packages/cli/src/lib/llm-eval.ts`.** Never hard-code binary paths (`codex`, `claude`) or `execSync`/`execFileSync` calls in command handlers.

**Re-use chain:**
- `llmEval(prompt, {model?})` → full fallback chain (Codex primary → Claude fallback)
- `tryCodexPrint(prompt)` → codex `--print --no-input` only
- `tryClaudePrint(prompt)` → claude `--print --no-input` only
- `resolveCodexBinary()` is imported from `@jleechanorg/ao-plugin-agent-codex` — do not re-implement path detection

**Why:** `llm-eval.ts` centralizes timeout, error classification (ENOENT vs real failure), fail-closed VERDICT parsing, and cross-platform binary resolution. Scattering `execSync("codex ...")` strings across command handlers causes inconsistent error handling and hard-to-find bugs.

## What "Config" Covers

The yaml config is richer than it looks. Before coding, check:

```yaml
reactions:          # Handle any lifecycle event (ci-failed, changes-requested, agent-stuck…)
agentRules:         # Inject instructions into every agent's system prompt
notificationRouting: # Route urgent/action/warning/info to specific notifiers
defaults:           # Global runtime, agent, workspace, notifiers
projects.*:         # Per-project overrides for all of the above
plugins:            # Plugin credentials and settings
```

## Zero-touch metric source of truth

Canonical metric definitions live in `docs/zero-touch-by-operator.md`.

When changing zero-touch semantics (including smoothness), update in lockstep:
- `docs/zero-touch-by-operator.md` (definition + formulas)
- `README.md` pointer section
- `AGENTS.md` / `CLAUDE.md` policy pointers
- Monitor/reporting scripts that compute the metric

Current smooth requirement:
- A PR is zero-touch smooth only if it is zero-touch-by-operator and has
  `max_inactivity_gap <= 60 minutes` across PR-open -> merge timeline events.


## 7-Green (summary)

All seven must hold: CI green; mergeable; CodeRabbit APPROVED; Bugbot clean; inline threads resolved; evidence when required; Skeptic PASS (not `SKIPPED`). Check merge first: `gh api repos/OWNER/REPO/pulls/N --jq '{state, merged}'`. After push: exit (no sleep-poll). Pre-push: `mergeableState` ≠ `dirty`.

**Full detail:** CR loop, evidence bundle, GraphQL gate-5, spawn gates, worktrees, lifecycle triage → `roadmap/claude-fork-reference.md`.

## Fork isolation

New files for new features; additive upstream edits; plugin-first; minimal core diff (`*-extensions.ts`); fork exports grouped in `index.ts`. **Risky:** `lifecycle-manager.ts`, `types.ts`, `config.ts`, `spawn.ts`. **Safe:** `packages/plugins/**`, `roadmap/`.

## Coding standards

TDD; strict TS; conventional commits; never push `main`; `--force-with-lease` only on your branches; never `git add -A`; ~300 LOC/file.

## Tests

```bash
pnpm --filter @composio/ao-core test
pnpm test
```

## Fork / PR target

`jleechanorg/agent-orchestrator`. Never upstream `ComposioHQ` PR without explicit approval. Strip fork artifacts for upstream cherry-picks.

## Skills (user scope + this repo)

Long-form operational skills live under **`~/.claude/skills/<name>/SKILL.md`** (restored from archive; beads **bd-pwku**). Examples: `ao-session-monitor`, `auton`, `harness-engineering`, `nextsteps`, `evolve-loop`. **Do not** treat duplicate loose copies in random paths as canonical.

**Repo index:** `.claude/skills/README.md` maps topics → user paths and fork **`roadmap/`** docs. Bundled in-repo: `.claude/skills/video-render/SKILL.md`.

---

| Deep reference | `roadmap/claude-fork-reference.md` |
|----------------|-------------------------------------|
