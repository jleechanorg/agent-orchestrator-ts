# Design: Onboarding Friction Reduction

**PR:** `feat/onboarding-improvements`
**Author:** Suraj + Claude
**Date:** 2026-03-13

## Motivation

New users hitting Agent Orchestrator for the first time faced multiple friction points that could cause them to abandon setup before ever spawning an agent. The goal of this PR is to make the path from `git clone` to `ao spawn` as smooth as possible — ideally zero interruptions.

## Problems Identified

| # | Problem | Severity | Who it affects |
|---|---------|----------|----------------|
| 1 | `setup.sh` crashes with EACCES on `npm link` | **Blocking** | Every macOS user |
| 2 | `ao init` asks 13 prompts before generating config | **High friction** | Every new user |
| 3 | Adding a second project requires editing YAML by hand | **High friction** | Multi-project users |
| 4 | `ao start` crashes if configured port is busy | **Medium friction** | Users running other dev servers |
| 5 | `--smart` flag shows "coming soon" placeholder | **Low friction** | Users exploring CLI flags |
| 6 | Same `npm link` bug exists in `ao update` and `ao doctor --fix` | **Blocking** | Users updating or diagnosing |

## Changes

### 1. Fix `npm link` permission error (setup.sh, ao-update.sh, ao-doctor.sh)

**Before:** `npm link` fails with EACCES on macOS. Script exits. User is stuck with no `ao` command and no guidance.

**After:** Script tries `npm link` first. If it fails and the terminal is interactive, auto-retries with `sudo`. If non-interactive (CI), prints the manual command.

**Files changed:**
- `scripts/setup.sh`
- `scripts/ao-update.sh`
- `scripts/ao-doctor.sh`

### 2. Make `ao init` default to auto-detection

**Before:**
- `ao init` → 13 interactive prompts (data dir, worktree dir, port, runtime, agent, workspace, notifiers, project ID, repo, path, branch, tracker, team ID)
- `ao init --auto` → auto-detection with zero prompts

Most users should use `--auto` but it wasn't the default, pushing every new user through the long wizard.

**After:**
- `ao init` → auto-detects everything, zero prompts (was `--auto`)
- `ao init --interactive` → full wizard for users who want manual control

**Files changed:**
- `packages/cli/src/commands/init.ts`

### 3. Add `ao add-project <path>` command

**Before:** Adding a project to an existing config meant opening `agent-orchestrator.yaml` and manually writing YAML with the correct structure, session prefix, and repo format.

**After:**
```bash
ao add-project ~/Desktop/mono
```

One command that:
1. Resolves the path
2. Finds the existing `agent-orchestrator.yaml`
3. Detects git remote (`owner/repo`)
4. Detects default branch (main/master/etc.)
5. Generates a unique session prefix (validates against existing ones)
6. Detects project type (language, framework, test runner)
7. Generates agent rules from templates
8. Appends the project to the config and writes it back

**Files changed:**
- `packages/cli/src/commands/add-project.ts` (new)
- `packages/cli/src/index.ts` (command registration)

### 4. Auto-find free port on `ao start`

**Before:** If port 3000 (or whatever is in config) was busy, `ao start` threw an error and stopped:
```
Port 3000 is already in use. Free it or change 'port' in agent-orchestrator.yaml.
```

**After:** Automatically finds the next available port and uses it:
```
Port 3000 is busy — using 3001 instead.
```

Only fails if no port is available in the scan range.

**Files changed:**
- `packages/cli/src/commands/start.ts`

### 5. Remove `--smart` placeholder

**Before:** `ao init --auto --smart` showed "AI-powered rule generation not yet implemented — using template-based rules for now". A dead feature flag that confused users.

**After:** Removed entirely. Template-based rules are the default and work well.

**Files changed:**
- `packages/cli/src/commands/init.ts`

## New Onboarding Flow

### Before (5+ minutes, multiple failure points)

```
git clone ... && cd agent-orchestrator
bash scripts/setup.sh              # Could crash on npm link
cd ~/my-project
ao init                            # 13 prompts
# Want to add another project?     # Edit YAML by hand
ao start                           # Could crash on port conflict
```

### After (2 minutes, zero interruptions)

```
git clone ... && cd agent-orchestrator
bash scripts/setup.sh              # Handles permissions automatically
cd ~/my-project
ao init                            # Zero prompts, auto-detects everything
ao add-project ~/other-project     # One command to add more projects
ao start                           # Auto-finds free port if needed
ao spawn my-project 123            # Start working
```

## UX Impact

| Metric | Before | After |
|--------|--------|-------|
| Steps to first `ao spawn` | 6+ (with manual edits) | 4 (all automated) |
| Interactive prompts in `ao init` | 13 | 0 |
| Permission errors during setup | Fatal crash | Auto-handled |
| Port conflicts on `ao start` | Fatal crash | Auto-resolved |
| Adding a second project | Manual YAML editing | `ao add-project <path>` |
| Dead CLI flags | `--smart` shows "coming soon" | Removed |

## Backward Compatibility

- `ao init --auto` still works (now equivalent to `ao init`)
- `ao init` interactive wizard still available via `ao init --interactive`
- `ao start` behavior is strictly improved — auto-port was already the behavior for URL-based starts, now it's the default for all starts
- No config format changes
- No breaking changes to any existing command

## Related Issues

- [#454](https://github.com/ComposioHQ/agent-orchestrator/issues/454) — Codex plugin stability improvements (spawned as a parallel agent session)
- [#456](https://github.com/ComposioHQ/agent-orchestrator/issues/456) — Dashboard shows orchestrator as "Exited" due to startup race condition

## Test Plan

- [ ] Fresh `bash scripts/setup.sh` on macOS without sudo permissions pre-granted
- [ ] `ao init` in a git repo with GitHub remote → generates correct config with zero prompts
- [ ] `ao init --interactive` → shows full 13-prompt wizard
- [ ] `ao add-project ~/some-repo` → appends project with correct detection
- [ ] `ao add-project` on already-added project → shows clear error
- [ ] `ao start` with port 3000 busy → auto-finds 3001 and starts
- [ ] `ao update` with permission issue → auto-retries with sudo
- [ ] `ao doctor --fix` with permission issue → auto-retries with sudo
