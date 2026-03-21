# CLAUDE.md — Agent Orchestrator Fork Guidelines

This file is read by Claude Code when working in this repository.

## Development Hierarchy

**Before writing any code, follow this order:**

| Priority | Approach | When to use |
|---|---|---|
| 1 | **Config** | Behavior expressible via `agent-orchestrator.yaml` (reactions, agentRules, routing) |
| 2 | **New plugin** (existing slot) | New runtime, agent, SCM, tracker, notifier, or workspace implementation |
| 3 | **New plugin type** (new slot) | Behavior that needs a new plugin slot in plugin-registry |
| 4 | **Core code change** | Only when 1–3 are genuinely insufficient — justify in PR |

Core code (`packages/core/src/`) should be treated as stable infrastructure. The vast majority of new capabilities should live in plugins. Roadmap docs, design notes, and fork-specific tooling config live in `roadmap/`, `.beads/`, and `CLAUDE.md` — these are first-class artifacts, not noise.

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

## Definition of a "Green" PR

A PR is green when **ALL FOUR** are true:

1. **CI green** — all required GitHub Actions checks pass (no failures, no pending required)
2. **No merge conflicts** — `mergeable: MERGEABLE` (not CONFLICTING)
3. **No serious unresolved comments** — no actionable items from CodeRabbit, Cursor Bugbot, Copilot, or human reviewers (nitpicks are OK)
4. **CodeRabbit approved** — latest verdict is APPROVE or LGTM (REQUEST_CHANGES is a blocker)

**Never declare a PR green or ask for merge unless all 4 are true.**

## Fork Isolation — Code Separation from Upstream

This fork diverges from `ComposioHQ/agent-orchestrator`. To minimize merge conflicts and preserve cherry-pick ability:

### Rules

1. **New features go in new files** — never add fork logic inline to upstream files. Create a separate module and import it.
2. **Extend, don't modify** — if you must touch an upstream file (types.ts, config.ts, lifecycle-manager.ts), prefer additive-only changes (new union members, new interface fields, new exports). Exception: extracting existing fork logic *out* of upstream files into companion modules is encouraged — it reduces the upstream diff even though it restructures the file.
3. **Plugin-first** — use the plugin system (agent, runtime, scm, notifier, poller, workspace) for new capabilities. Plugins are entirely isolated by design.
4. **Keep core diff minimal** — `packages/core/src/` files should have the smallest possible diff against upstream. Extract fork logic into `*-extensions.ts` or `fork-*.ts` companion files.
5. **Re-exports over inline** — when adding exports to `index.ts`, group fork-specific exports together at the bottom with a comment marker.

### High-Conflict Files (minimize changes)

| File | Why it's risky |
|------|---------------|
| `lifecycle-manager.ts` | Core polling loop; upstream actively develops this |
| `types.ts` | Shared type definitions; union extensions add lines near upstream changes |
| `config.ts` | Zod schemas; upstream adds fields here too |
| `spawn.ts` | CLI entry point; upstream refactors argument parsing |

### Safe Files (no conflict risk)

- Everything in `packages/plugins/` — entirely new packages
- `roadmap/`, `.beads/`, `docs/design/` — fork-only documentation
- New `packages/core/src/*.ts` files — net new, no upstream equivalent

## Test Classification — Mandatory Naming and Content Rules

**These rules are enforced. Violations are trust violations.**

### File naming determines test tier
| File pattern | Tier | Requirements |
|---|---|---|
| `*_e2e_*` or `*_e2e.py` or `*e2e*` | **E2E** | Must meet ALL criteria below |
| `*_integration_*` | **Integration** | Real I/O, real APIs, but may skip full pipeline |
| `*_test_*` or `test_*` (default) | **Unit** | May use mocks, stubs, fakes |

### E2E test mandatory criteria
A test file named with "e2e" MUST satisfy ALL of these. If ANY is false, rename it to `*_integration_*` or `*_smoke_*`:

1. **Spawns real external work** — e.g., `ao spawn` a session that actually runs, `gh pr create`, etc.
2. **Waits for that work to complete** — not spawned and immediately killed. The external process must do real work (push code, run CI, etc.).
3. **Verifies an outcome that only exists if the full pipeline ran** — e.g., a PR was created, CI passed, a merge happened.
4. **Creates its own test data** — does not rely on pre-existing PRs, sessions, or resources.
5. **Takes >60 seconds** — if it completes in under a minute, it's not E2E.

### What is NOT an E2E test
- Importing a module and checking it's callable → **unit test**
- Writing to a temp file and reading it back → **unit test**
- Calling a real API to check status of a pre-existing resource → **integration test**
- Spawning a session and immediately killing it → **smoke test**
- Constructing an event in Python and routing it → **integration test**

### Before committing any test with "e2e" in the name
Ask: "If I showed this to the user and said 'the E2E test passes', would they agree this proves the system works end-to-end?" If there's any doubt, use a more honest name.

### Evidence claim-class matrix — fail-closed verdicts (bd-7ay)

When reviewing or producing evidence, identify the **claim class** before issuing a verdict. Verdict is **INSUFFICIENT** (not PASS) if required proofs for the claimed class are missing.

| Claim class | Required proofs |
|---|---|
| **Unit test coverage** | Test file path, pass/fail counts, coverage % |
| **Integration test** | Test log with real I/O, API calls shown, timing |
| **Pipeline E2E** | Session spawn proof, event routing proof, outcome recording proof |
| **PR-lifecycle E2E** | PR creation (URL+timestamp+actor), transition proof (CI/review timeline), merge outcome, cleanup proof |
| **Merge-gate green** | All conditions checked with evidence per condition |

**Fail-closed rules:** PASS only if ALL required proofs are present. INSUFFICIENT if any missing. Never downgrade the claim class to avoid INSUFFICIENT. A pipeline E2E does NOT satisfy a PR-lifecycle E2E claim.

## Coding Standards

- TDD: write the failing test first, then implement
- TypeScript strict: no `any`, no `// @ts-ignore`
- Conventional commits: `feat:`, `fix:`, `chore:`, `docs:`, `test:`
- Never push to main — always open a PR
- Never `git add -A` — stage only files you changed
- Files under ~300 LOC; split for clarity

## Running Tests

```bash
pnpm --filter @composio/ao-core test        # core package only
pnpm test                                   # all packages
```

## This Is an Independent Fork

This repo is `jleechanorg/agent-orchestrator`. It started as a fork of `ComposioHQ/agent-orchestrator` but is now developed independently. Upstream sync is not a goal.

- All PRs target `jleechanorg/agent-orchestrator`
- `roadmap/` docs are tracked and welcomed — they are the design record for this fork
- `.beads/issues.jsonl` is the issue tracker — commit it when beads are opened or closed
- Remote `jleechanorg` points to the fork; `origin` points to upstream (read-only)
- **Upstream-strip rule**: When preparing PRs to `ComposioHQ/agent-orchestrator`, remove all fork-only artifacts. Explicitly exclude: `CLAUDE.md`, `AGENTS.md`, `roadmap/`, `.beads/`, `docs/design/*.md`, and any commits referencing fork-specific infra (openclaw, jleechanorg-specific tooling).

## PR Target — CRITICAL SAFETY RULE

**NEVER open a PR against `ComposioHQ/agent-orchestrator` without explicit in-thread approval from jleechan.**

Before creating any PR, confirm the target repo. If the target is `ComposioHQ/agent-orchestrator`, stop and ask:
> "This would open a PR against the ComposioHQ upstream. Do you approve?"

Default target is always `jleechanorg/agent-orchestrator`. When approved, strip fork-only artifacts: `CLAUDE.md`, `AGENTS.md`, `roadmap/`, `.beads/`, `docs/design/*.md`, and commits referencing fork infrastructure.

## Upstreaming to ComposioHQ — What to Strip

When cherry-picking work to a `feat/*-upstream` branch for a ComposioHQ PR, **do not include**:

- `docs/design/*.md` — fork-only markdown design docs (HTML equivalents are fine)
- `CLAUDE.md` — fork-specific Claude Code instructions
- `AGENTS.md` — fork-specific agent/contributor guidelines
- `roadmap/` — fork roadmap docs
- `.beads/` — local issue tracker
- Any commit that references fork infrastructure (openclaw, jleechanorg-specific tooling)

## Bulk PR Merging

Use `/bulk-merge` to evaluate, risk-assess, and sequentially merge multiple PRs. See `.claude/commands/bulk-merge.md` for the full workflow. Key points:

- Verify all 4 green checks before merging any PR
- Merge low-risk (additive-only) PRs first, smallest to largest
- Medium-risk (modifies existing files) PRs merge after low-risk
- Resolve `index.ts` and `.beads/issues.jsonl` conflicts between each merge (keep both sides)
- Run `pnpm build && pnpm test && pnpm typecheck` after all merges complete

## Mirror Fork for Clean Upstream PRs

There is a separate mirror fork at `jleechan2015/agent-orchestrator-mirror` that mirrors `ComposioHQ/agent-orchestrator` exactly. Use this for submitting PRs that should go upstream without custom fork logic:

- **Location**: `~/projects_reference/agent-orchestrator-mirror`
- **Purpose**: Submit Cursor/Gemini CLI support to upstream without MCP mail or other custom changes
- **Workflow**:
  1. Sync mirror to `ComposioHQ/agent-orchestrator` main
  2. Copy desired plugins (agent-cursor, agent-gemini, agent-base) from this fork
  3. Remove any custom logic (MCP mail, etc.)
  4. Push and create PR against the mirror, not upstream

**Current mirror PR**: https://github.com/jleechan2015/agent-orchestrator-mirror/pull/1

This fork's work will be proposed to ComposioHQ separately from this repo's custom development.

## AO Infrastructure Operations

### Config path and data namespace

AO uses `SHA256(dirname(configPath))` to create isolated data directories under `~/.agent-orchestrator/{hash}-{projectId}/`. The hash is derived from the **directory containing `agent-orchestrator.yaml`**, not the file itself.

**Canonical config**: `~/.openclaw/agent-orchestrator.yaml` (hash: `bb5e6b7f8db3`)

**NEVER create a second `agent-orchestrator.yaml`** in another directory. Running `ao` from a directory that contains its own `agent-orchestrator.yaml` creates a shadow namespace — sessions, PID files, and logs go to a different data dir, invisible to the lifecycle-worker.

### Decommissioning an AO config path or project directory

Before deleting any directory that contains (or contained) `agent-orchestrator.yaml`:

1. **Kill all tmux sessions** using that namespace: `tmux list-sessions | grep <prefix>` then `tmux kill-session -t <name>`
2. **Kill the lifecycle-worker** for that namespace: check PID files in `~/.agent-orchestrator/*-agent-orchestrator/lifecycle-worker.pid`
3. **Kill the orchestrator session** if running: `tmux kill-session -t *-ao-orchestrator`
4. **Then delete** the directory
5. **Verify** no processes remain: `ps aux | grep lifecycle-worker.*agent-orchestrator`
