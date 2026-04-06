# Evidence Theater Diagnosis

**Date:** 2026-04-05
**Status:** Actionable — fixes identified, implementation pending

## Problem

40 merged PRs audited. Zero have ever produced a real terminal media artifact
(asciinema cast, .gif, .mp4, or localhost screenshot). Every `**Terminal media**`
line is `N/A`. Every `**UI media**` line is `N/A - no UI changes`.

Workers consistently self-select the lowest claim class that passes the gate:
- `documentation-only` — no artifacts required
- `unit` — only needs fenced test output + gist; N/A accepted for both media fields

The evidence gate exists and works correctly for the rules it enforces. The rules
themselves have structural gaps.

## Root causes

### 1. Claim class self-selection with no floor

Workers choose their own claim class. Nothing enforces a minimum based on what
files actually changed. A PR touching `src/` code gets classified as `unit` and
skips all strong-proof checks.

### 2. Terminal media N/A bypass is unchecked

`evidence-gate.yml` line 328 accepts `N/A` for Terminal media regardless of claim
class. Compare to `wholesome.yml` lines 244-250 which correctly scope N/A to
`unit` claims only. This is a bug — the two gates are inconsistent.

### 3. Media skills have no caller

`tmux-video-evidence`, `ui-video-evidence`, and `smoke-test-local` exist as
skill files on disk. Nothing in the PR workflow, agentRules, or pre-push hooks
triggers them. Per CLAUDE.md automation completeness rule: a script on disk with
no caller is not automation.

## Proposed fixes (priority order)

### Fix 1: Close Terminal media N/A bypass (quick win)

**File:** `.github/workflows/evidence-gate.yml` line 328
**Change:** Guard N/A acceptance with claim class check:
```bash
# Before (accepts N/A for any claim):
if printf '%s' "$TM_BLOCK" | grep -qiE 'N/A'; then

# After (N/A only for unit):
if [ "$CLAIM" = "unit" ] && printf '%s' "$TM_BLOCK" | grep -qiE 'N/A'; then
```
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

**File:** `agent-orchestrator.yaml` agentRules section
**Change:** Add rule: "For PRs with claim class `integration` or higher, you MUST
run the `tmux-video-evidence` skill to capture terminal media before creating the
PR body. Do not write `N/A` for Terminal media on code-change PRs."

**Risk:** Low. Workers may still ignore instructions (they already ignore the
existing evidence standard docs). Follow up with a hook if instruction-only
enforcement proves insufficient.

## Open PRs

- **#388** — Missing `## Evidence` entirely. Gate cannot parse it. Should be closed
  (superseded by #389).
- **#389** — Same issue. Needs evidence section added before it can pass the gate.

## Related

- CLAUDE.md: "Automation completeness — scripts must have callers"
- `docs/evidence/strong-evidence-standard.md`: Bundle v2 spec
- `.github/workflows/wholesome.yml`: Secondary evidence enforcement (has correct N/A scoping)
