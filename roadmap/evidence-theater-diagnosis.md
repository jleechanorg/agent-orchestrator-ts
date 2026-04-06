# Evidence Theater Diagnosis

**Date:** 2026-04-05
**Status:** In progress — Fix 1 implemented (bd-cam93); Fix 2 (bd-4ze23) and Fix 3 pending

## Problem

40 merged PRs audited. Zero have ever produced a real terminal media artifact
(asciinema cast, .gif, .mp4, or localhost screenshot). Every `**Terminal media**`
line is `N/A`. Every `**UI media**` line is `N/A - no UI changes`.

Workers consistently self-select the lowest claim class that passes the gate:
- `documentation-only` — no strong-artifact check required; Evidence Gate only
  verifies a claim class and PASS verdict are present.
- `unit` — strong-artifact check skipped; gate only verifies the section exists
  with a PASS verdict. No gist or fenced test output is enforced at the gate level.

The evidence gate exists and works correctly for the rules it enforces. The rules
themselves have structural gaps.

## Root causes

### 1. Claim class self-selection with no floor

Workers choose their own claim class. Nothing enforces a minimum based on what
files actually changed. A PR touching `src/` code gets classified as `unit` and
skips all strong-proof checks (which only run for `integration`+).

### 2. Terminal media N/A bypass is unchecked

`evidence-gate.yml` accepted `N/A` for Terminal media regardless of claim class
(pre-Fix-1). Compare to `wholesome.yml` lines 244-250 which correctly scope N/A
to `unit` claims only. This inconsistency allowed `integration`+ claim PRs to pass
the Terminal media check with just `N/A`.

### 3. Media skills have no caller

`tmux-video-evidence`, `ui-video-evidence`, and `smoke-test-local` are user-scope
skills (`~/.claude/skills/`) referenced in `~/.claude/skills/README.md`. Nothing
in the PR workflow, `agentRules`, or pre-push hooks triggers them. Per the global
CLAUDE.md policy ("a script on disk with no caller is not automation"), this is an
automation completeness gap.

## Proposed fixes (priority order)

### Fix 1: Close Terminal media N/A bypass ✅ IMPLEMENTED (bd-cam93)

**File:** `.github/workflows/evidence-gate.yml`
**Change:** N/A for Terminal media now only accepted when `CLAIM` is `unit` or
`documentation-only`. `integration`+ claims must supply a real HTTPS URL.
**Risk:** Low. Aligns evidence-gate with wholesome.yml behavior.

### Fix 2: Claim class floor rule (high impact)

**File:** `.github/workflows/evidence-gate.yml` claim extraction step (~line 82)
**Change:** After extracting the worker's declared claim class, check `git diff`
for code file changes (`.ts`, `.js`, `.py`, `.go`, etc.). If code files changed,
enforce minimum `integration` claim class.

**Risk:** Medium. May break PRs that legitimately touch code but only need unit
tests (e.g., fixing a typo in a string literal). Consider an escape hatch:
`**Claim floor override**: <justification>` that skeptic can evaluate.

### Fix 3: agentRules media instruction (enforcement via instruction)

**File:** `agent-orchestrator.yaml` (local config, not committed; update
`agent-orchestrator.yaml.example` for repo reference)
**Change:** Add agentRules entry: "For PRs with claim class `integration` or
higher, run the user-scope `tmux-video-evidence` skill (`~/.claude/skills/
tmux-video-evidence/`) to capture terminal media before creating the PR body.
Do not write `N/A` for Terminal media on code-change PRs."

**Risk:** Low. Workers may still ignore instructions; follow up with a hook if
instruction-only enforcement proves insufficient.

## Open PRs

- **#388** — Missing `## Evidence` entirely. Gate cannot parse it. Should be closed
  (superseded by #389).
- **#389** — Same issue. Needs evidence section added before it can pass the gate.

## Beads

- `bd-cam93` — evidence-gate: close N/A bypass (Fix 1, ✅ implemented)
- `bd-4ze23` — evidence-gate: wire tmux-video-evidence + smoke-test-local as mandatory pre-push (Fix 3)
- `bd-p2auf` — fix PRs #388 and #389: add ## Evidence sections

## Related

- Global `~/.claude/CLAUDE.md`: "Automation completeness — scripts must have callers"
- `.github/workflows/wholesome.yml`: Secondary evidence enforcement (has correct N/A scoping)
- `.claude/skills/README.md`: Canonical index — operational skills live in user scope `~/.claude/skills/`
