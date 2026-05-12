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

### Fork worker binary resolution — TWO layers must agree

When setting up a lifecycle-worker launchd plist, two independent binary resolutions must both point to the **source tree** CLI (not the global npm):

1. **`ProgramArguments[1]`** — the process entry point in the plist
2. **`execFile("ao", ...)` calls inside the running worker** — resolved via `PATH` and `AO_CLI_PATH`

**The trap**: If only layer 1 uses the source binary but layer 2 resolves via PATH to the global npm (`/Users/jleechan/bin/ao`), internal commands like `ao skeptic verify` will silently fail because the global npm lacks fork subcommands.

**The portable fix** (handled automatically by `scripts/setup-launchd.sh` + `scripts/start-all.sh`):
- `setup-launchd.sh` sets `AO_CLI_PATH` in the plist to the source CLI path
- `start-all.sh` resolves `ao` via `_ao_bin()` (source-first) before spawning workers
- The plist template includes `AO_CLI_PATH` as an env var so `execFile` calls inside the worker use the correct binary

**Manual plist authoring**: If you write a plist by hand, you MUST set both:
```xml
<key>EnvironmentVariables</key>
<dict>
    <!-- ... -->
    <key>AO_CLI_PATH</key>
    <string>/path/to/repo/packages/cli/dist/index.js</string>
</dict>
```
And use the source `packages/cli/dist/index.js` as `ProgramArguments[1]`, not the global `ao` binary.

**Post-install verification** (mandatory after `setup-launchd.sh lifecycle`):
```bash
ps eww -p $(pgrep -f "lifecycle-worker") | grep MINIMAX_API_KEY
# Must show the real key — not empty, not ***

# Also verify spawned tmux sessions get ANTHROPIC_API_KEY:
# ao spawn "echo AKEY=\$ANTHROPIC_API_KEY"  # should show non-empty value
```

**macOS launchd user agents** (in `~/Library/LaunchAgents/`):
- Use `launchctl bootout gui/$(id -u)/<label>` — NOT `sudo launchctl unload`
- `sudo launchctl` targets root's session and will fail with I/O error for user-owned agents
- Helper: `~/.claude/hooks/ao-launchd-reload.sh <plist-path>` auto-detects user vs system

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

**AO usage skill:** `skills/agent-orchestrator/SKILL.md`

- `bash scripts/setup.sh` installs this repo skill into `~/.claude/skills/agent-orchestrator` and `~/.codex/skills/agent-orchestrator`.
- When you need the operational AO workflow, read that skill before inventing an ad hoc spawn/status/send pattern.

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

## Skeptic Gate Verification

**Rule:** After triggering skeptic (via GHA workflow_dispatch, pull_request event, or cron), always verify a VERDICT comment appeared on the PR before calling the PR "skeptic-passed."

- A GitHub Actions workflow exiting with status "success" does **NOT** mean skeptic passed — the polling step in `skeptic-gate.yml` was historically a broken stub (`echo waiting`).
- Verify by checking PR comments for a skeptic bot comment that includes both:
  1) `<!-- skeptic-agent-verdict -->` marker, and
  2) `VERDICT: PASS`.
- If no VERDICT appears within the polling timeout (default 50 minutes, configurable via `poll_timeout_minutes` input in `skeptic-gate-reusable.yml`), treat it as a **FAILED** gate, not a passed one.

## LLM Evaluation — Shared Utility

**All LLM evaluation (skeptic, verifier, exit-criteria checks) MUST route through `packages/cli/src/lib/llm-eval.ts`.** Never hard-code binary paths (`codex`, `claude`) or `execSync`/`execFileSync` calls in command handlers.

**Re-use chain:**
- `llmEval(prompt, {model?})` → full fallback chain (Codex primary → Claude fallback)
- `tryCodexPrint(prompt)` → codex `exec -` only (prompt via stdin)
- `tryClaudePrint(prompt)` → claude `--dangerously-skip-permissions --print` only (stdin-pipe)
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

**Evidence Requirement**: Every pull request MUST include a `## Evidence` section with links to authoritative gists. UI/Terminal claims MUST be supported by video evidence (.mp4, .gif, or .cast) and MUST show the TDD Red-Green cycle. Capture the failure first. See [evidence-standards](skills/evidence-standards/SKILL.md) and [tdd-evidence-workflow](skills/tdd-evidence-workflow/SKILL.md).

## Fork isolation

New files for new features; additive upstream edits; plugin-first; minimal core diff (`*-extensions.ts`); fork exports grouped in `index.ts`. **Risky:** `lifecycle-manager.ts`, `types.ts`, `config.ts`, `spawn.ts`. **Safe:** `packages/plugins/**`, `roadmap/`.

## Coding standards

TDD (Red-Green-Evidence cycle); strict TS; conventional commits; never push `main`; `--force-with-lease` only on your branches; never `git add -A`; ~300 LOC/file.

TDD is MANDATORY for all bug fixes and features. You MUST capture the "Red" phase (initial failure) as part of your evidence bundle to prove the existence of the issue before the fix.

## Tests

```bash
pnpm --filter @jleechanorg/ao-core test
pnpm test

# Provider integration tests (require real API keys + tmux)
pnpm --filter @jleechanorg/ao-integration-tests test:integration -- -t "agent-(wafer|minimax|zai)"
```

### Provider E2E test coverage

| Provider | Test file | API key | Assertions |
|----------|-----------|---------|------------|
| Wafer/GLM-5.1 | `agent-wafer.integration.test.ts` | `WAFER_API_KEY` | 6 |
| MiniMax | `agent-minimax.integration.test.ts` | `MINIMAX_API_KEY` | 6 |
| Z.AI/GLM-5.1 | `agent-zai.integration.test.ts` | `GLM_API_KEY` | 8 |

## Fork / PR target

`jleechanorg/agent-orchestrator`. Never upstream `ComposioHQ` PR without explicit approval. Strip fork artifacts for upstream cherry-picks.

## Provider Agent Plugins (wafer, minimax)

AO supports third-party LLM providers via thin adapter plugins that reuse the `claude` CLI binary but redirect API calls to a different Anthropic-compatible endpoint.

| Agent flag | Provider | Base URL | API key env var | Default model |
|------------|----------|----------|-----------------|---------------|
| `--agent wafer` | Wafer | `https://pass.wafer.ai` | `WAFER_API_KEY` | `GLM-5.1` |
| `--agent minimax` | MiniMax | `https://api.minimax.io/anthropic` | `MINIMAX_API_KEY` | (server-selected) |

**How it works:** Both plugins set `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY` in the worker environment so the `claude` binary sends requests to the provider's endpoint instead of Anthropic. The provider must expose an Anthropic-compatible API.

**Usage:**
```bash
ao spawn --agent wafer "implement fibonacci"
ao spawn --agent minimax "implement fibonacci"
```

**Inline prefix alternative:** The `claude-code` plugin also supports `wafer.ai/` model prefix (e.g. `model: wafer.ai/GLM-5.1` in config). The dedicated `--agent wafer` plugin is preferred for clarity.

**Plugin source:** `packages/plugins/agent-wafer/`, `packages/plugins/agent-minimax/`

## Binary Installation — Canonical Install Paths

**Two install paths exist for different audiences:**

| Audience | Install command | Notes |
|----------|---------------|-------|
| **This repo's maintainers** (you) | `bash scripts/setup.sh` | Builds from current source tree via **`pnpm install -g .`** (from `packages/cli`) — always latest SHA |
| **Other people / other machines** | `npm install -g @jleechanorg/ao-cli` | Standard npm install — published package |

| Task | Command |
|------|---------|
| Fresh install (repo maintainers) | `bash scripts/setup.sh` |
| Update to latest main | `bash scripts/ao-update.sh` |
| Verify install health | `ao doctor` |

**Why `scripts/setup.sh`?** It builds from the current source tree and runs **`pnpm install -g .`** in `packages/cli`, which registers the built `ao` in your pnpm global bin (set **`PNPM_HOME`** and put it on **`PATH`** — the script prints hints if `ao` is missing). Plain **`npm install -g .`** cannot install this monorepo CLI because scoped workspace dependencies are not all on the public registry. The running binary matches the source tree SHA — no lag.

**Why `scripts/ao-update.sh` over `npm update -g`?** `ao-update.sh` kills existing lifecycle-workers before rebuilding, then restarts them. Running `npm update` without this sequence leaves old workers on stale code while a new binary is installed.

**After every install or update, run `ao doctor` and confirm zero FAIL results before spawning workers.** `ao doctor` detects non-canonical lifecycle-workers (running from a different binary path than `command -v ao`). If `ao doctor --fix` is needed, run it and re-verify.

**All worker invocations (including launchd plist) must call `ao` as a command resolved from PATH — never a hardcoded path.** After `scripts/setup.sh` or `scripts/ao-update.sh`, the **`pnpm install -g .`** step makes the built CLI the `PATH`-visible `ao` binary (under **`PNPM_HOME`** by default). For published-package users, `npm install -g @jleechanorg/ao-cli` installs into the npm global prefix instead.

**Verify the publish pipeline works before documenting an install path.** If a mechanism (e.g. `release.yml`, a workflow, a script) is broken, fix it before documenting the install path that depends on it. Documenting a broken install path creates a bad experience for every user who follows it.

## Skills (user scope + this repo)

Long-form operational skills live under **`~/.claude/skills/<name>/SKILL.md`** (restored from archive; beads **bd-pwku**). Examples: `ao-session-monitor`, `auton`, `harness-engineering`, `nextsteps`, `evolve-loop`. **Do not** treat duplicate loose copies in random paths as canonical.

This repo also ships **`skills/agent-orchestrator/SKILL.md`** and installs it into user scope during setup so AO usage guidance stays aligned with the repo.

**Repo index:** `.claude/skills/README.md` maps topics → user paths and fork **`roadmap/`** docs. Bundled in-repo: `.claude/skills/video-render/SKILL.md`.

---

| Deep reference | `roadmap/claude-fork-reference.md` |
|----------------|-------------------------------------|
