# Session registry harness — ground truth vs `ao session ls`

**Date**: 2026-04-05  
**Status**: Proposed / tracked  
**Bead**: `bd-9gvm` (related: `bd-3h9` store/tmux desync)

## Problem

Live operations showed **many tmux sessions idle at the Claude prompt** (`❯`) while **`ao session ls`** still listed rows as **`[working]`** or stale **`[spawning]`**. That creates:

- **False confidence** that workers are computing when they are waiting for the next prompt, external CI, or a **permission / compose** dialog.
- **Capacity planning errors** (spawn gates, “how many workers are running?”).
- **Contradiction** with the inverse failure mode already tracked: **`bd-3h9`** (metadata says working but tmux missing).

We need a **harness** fix: instructions + optional product changes so the **same mistake does not recur**.

## Latest operator evidence (2026-04-09)

- **PR #6174 (`wa-260`)** — repeated **`Context limit reached`** in tmux and stale PR metadata in **`ao status`**.
- **PR #6172 (`wa-222`)** — repeated **`Context limit reached`** loop; generic nudges were not recovering it.
- **PR #6171 (`wa-261`)** — pane showed **`Baked for ...`** plus prompt after review activity; effectively idle, not actively working.
- **PR #6166 (`wa-252`)** — **`invalid_request_error`** / unsupported-model failure; session should have been respawned, not treated as productive.
- **PR #6136 (`wa-218`)** — blocked on **`Do you want to make this edit`**; this is `needs_input`, not “working”.

These sweeps show that the harness needs **blocked-state classification and recovery**, not just better idle/busy wording.

## Truth hierarchy (operator contract)

1. **Ground truth for “is the model busy?”** — **`tmux capture-pane`** (read **20+ lines**; look for Unicode activity `✻✶✳✽✾` *or* tool output before the prompt). Short captures falsely look idle **or** busy.
2. **Secondary** — **Claude Code JSONL** tail via agent **`getActivityState`** (when available): last entry type + age vs threshold.
3. **Registry** — **`ao session ls` `status`** (`working` / `idle` / `spawning` / `killed`): **coarse**, updated on **lifecycle polls** and **`onIdle`** callbacks; **do not treat `[working]` as proof of active inference.**

## Root cause (technical)

Session **`status`** in metadata stays **`working`** until **`onIdle`** persists **`idle`**. **`onIdle`** depends on runtime + **activity detection** (`classifyTerminalOutput` on pane text, **`getActivityState`** on JSONL). Misclassification, long scrollback, permission prompts, or slow polls → **registry lags**.

## Root cause (agent / process)

Instructions emphasized **avoiding false “idle”** when monitoring tmux, but **not** avoiding **false “busy”** when reading **`ao session ls`**. No single doc in-repo stated the hierarchy above until this file + **`roadmap/README.md`**.

## Proposed work (pick any; bead tracks umbrella)

| Layer | Action |
|--------|--------|
| **Instructions** | Add **Truth hierarchy** bullet to repo **`CLAUDE.md`** (Monitoring / PR worker section): `ao session ls` ≠ live busy; verify with pane or JSONL. |
| **CLI** | **`ao session ls`**: show **`lastActivityAt`**, **`activity`**, and **`status`** on one line so stale `working` is obvious. |
| **Agent runtimes** | Add blocked-state fixtures for Codex + Claude so approval prompts, context-limit loops, unsupported-model panes, and baked-idle prompts classify correctly. Bead: **bd-8fhc**. |
| **Productivity recovery** | Nudge once, then compact/respawn for repeated context-limit blockers; respawn immediately on unsupported-model failures. Bead: **bd-alif**. |
| **Status authority** | Make explicit session PR metadata authoritative over branch autodetect so `ao status` cannot report the wrong PR. Bead: **bd-ybkv**. |
| **Build / deploy** | Add startup/doctor guardrails that fail when the installed `dist` is older than merged source behavior. Bead: **bd-5st6**. |
| **agent-claude-code** | Extend **`classifyTerminalOutput`** tests/fixtures: Claude **Unicode “thinking”** lines + **last line `❯`** → **idle** when appropriate. |
| **Lifecycle** | Optional: if **`getActivityState`** returns **`idle`** for **N consecutive polls**, **downgrade** metadata `status` (narrow change + tests). |
| **Hygiene** | Orchestrator prompts: prefer **exit when triage complete**; fix **unsubstituted `{{pr_number}}`** hooks so sessions do not sit in **no-op loops**; policy for **`--dangerously-skip-permissions`** where automation must not block on compose prompts. |

## Verification

- **Manual**: Idle pane at **`❯`** → registry shows **`idle`** or CLI shows **stale age** clearly.
- **Tests**: Unit tests for **`classifyTerminalOutput`** / activity; existing **session-reaper** / **reaper** tests still pass.

## References

- `packages/core/src/session-reaper.ts`, `packages/core/src/session-manager.ts` (`onIdle`)
- `packages/plugins/agent-claude-code/src/index.ts` — `detectActivity`, `getActivityState`
- `packages/core/src/tmux-session-sweeper.ts` — orphan idle thresholds
