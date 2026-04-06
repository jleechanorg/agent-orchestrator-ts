# Context Compaction Optimization

**Created**: 2026-04-05
**Trigger**: Claude Code auto-compaction firing at 15% of 1M context window; effective usable context severely reduced
**Related**: [claude-fork-reference.md](claude-fork-reference.md)

## Problem Statement

Claude Code's auto-compaction threshold (~150K tokens) does not scale with the 1M context window. It fires at 15% usage. Combined with heavy MCP/skills overhead (~100K+ per turn), effective usable context is severely reduced -- long sessions lose critical earlier context well before the window is meaningfully utilized.

## Root Causes

1. **Hardcoded 150K compaction threshold** -- designed for 200K window, not 1M
2. **`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` capped by `Math.min()`** -- can only lower the threshold, never raise it
3. **All disable methods fail** -- `autoCompactEnabled`, `DISABLE_AUTO_COMPACT`, etc. are ignored
4. **186 MCP tools = 99.8K tokens per turn** (49.9% of 200K window)
5. **~170 skill descriptions injected per turn** = ~15K tokens
6. **Duplicate CLAUDE.md loading** = ~23.8K waste
7. **`--continue` inherits old session's context window config** (v2.1.90 regression)

## Upstream Issues

| Issue | Summary |
|-------|---------|
| anthropics/claude-code#34202 | Threshold does not scale with context window |
| #42375 | Compaction at 6% with override set |
| #42817 | All disable methods fail |
| #42376 | `--continue` drops context (v2.1.90 regression) |
| #40352 | Race condition destroys transcript |
| #34363 | Buffer mismatch bug (fixed) |

## Beads

| Bead | Priority | Action | Status |
|------|----------|--------|--------|
| bd-cx01 | P1 | PreCompact hook (exit code 2 to block) | open |
| bd-cx02 | P2 | Trim MCP servers (~27K savings) | open |
| bd-cx03 | P2 | File upstream bug with telemetry | open |
| bd-cx04 | P2 | Version eval: v2.1.91 vs v2.1.77 | open |
| bd-cx05 | P1 | Upgrade path after PreCompact hook benchmark (e.g. v2.1.92) | open |
| bd-tl9t | P3 | Compaction telemetry (3.9x increase) | open |

## Telemetry (bd-tl9t)

- Apr 4-5: 147 `compact_boundary` events vs Mar 21-22: 38 (3.9x increase)
- Normalized: 0.29 per 100 user msgs (Apr) vs 0.10 (Mar)
- `preTokens` at compaction: 167K-186K (confirms 200K window, not 1M)

## MCP Trim Plan (bd-cx02)

Removable servers and estimated savings:

| Server | Tokens | Notes |
|--------|--------|-------|
| Notion | 8K | Unused in current workflows |
| Playwright | 12K | Redundant with Puppeteer |
| Puppeteer | 3K | Redundant with Playwright |
| React | 4K | Not needed for AO work |
| **Total** | **~27K** | |

See **bd-cx02** (MCP trim) and fork maintainer notes for the detailed server-by-server breakdown.

## Version Strategy (bd-cx04)

| Version | Key change | Risk |
|---------|-----------|------|
| v2.1.77 | Avoids `--continue` regression | Misses thrash-loop fix |
| v2.1.89 | Thrash-loop fix, PostCompact hook | Pre-regression |
| v2.1.90 | REGRESSION: `--continue` drops context | Do not use |
| v2.1.91+ | Transcript chain break fixes | Evaluate when stable |

**Recommendation**: Pin to v2.1.89 until v2.1.91+ is validated against the `--continue` regression and compaction threshold issues.

## Community Resources

- **ArkNill/claude-code-cache-analysis** -- proxy-based analysis of compaction behavior
- **Lydia Hallie (Anthropic)** -- acknowledged peak-hour context window tightening
- **Medium: Context Recovery Hook** -- workaround using PostCompact hook to re-inject critical context

## Session Findings (2026-04-06)

### PreCompact Hook -- Partial Coverage

- Hook fires on v2.1.77 (contradicts earlier "dead code" hypothesis)
- But only intercepts ~2% of compactions: 1 block out of 54 compact_boundary events
- Hook log showed 4 entries: 3 ALLOWED (AO workers), 1 BLOCKED (interactive)
- Multiple compaction code paths exist; hook only covers one

### Test Methodology -- tmux send-keys Does Not Reproduce

- tmux send-keys driven sessions have 0 system-reminders (vs 22 in real session)
- System-reminders contain ~15K of skill descriptions + hook context per turn
- This per-turn overhead is what causes compaction in real sessions
- Test sessions maxed at 18% context after 50+ prompts; main session hit 54 compactions
- Valid A/B test requires real interactive use, not scripted tmux input

### Optimizations Applied

| Change | Status | Impact |
|--------|--------|--------|
| MCP trim (9 dead servers) | Done | Faster startup |
| Marketplace plugin removal (165 skills) | Done | ~8-10K tokens/turn saved |
| PreCompact hook installed | Done | Blocks ~2% of compactions |
| Edit/Write permissions added | Done | No more permission dialogs |
| CLAUDE_CODE_DISABLE_1M_CONTEXT removed | Done (prior session) | Enables 1M context |

### Next Steps

1. bd-cx05: Upgrade to v2.1.92 -- **validation-only** for controlled interactive testing; do not yet update the default pin (v2.1.89) until compaction proves stable
2. bd-cx02: Further MCP/skills trim (user commands consolidation: ~1.3K tokens)
3. bd-cx03: File upstream bug with telemetry data
4. Consider reducing ~300 skill count through consolidation (biggest remaining lever)
