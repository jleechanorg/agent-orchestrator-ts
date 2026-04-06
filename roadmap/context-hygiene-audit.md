# Context Hygiene Audit — Periodic Overhead Detection

Created: 2026-04-06
Trigger: compose-commands.sh grew from 384 to 628 lines silently, adding gh api calls on every prompt
Bead: bd-cx08 (recurring)

## Why This Exists

Per-turn context overhead is the primary driver of premature compaction. It grows silently as hooks, skills, and MCP servers are added. This audit catches drift before it causes problems.

## What to Check (every 2 weeks)

### 1. Hook output sizes
```bash
# Check most recent session JSONL for hook injection volume
SESSION=$(ls -t ~/.claude/projects/*/b*.jsonl 2>/dev/null | head -1)
grep -c "system-reminder\|hook_additional_context\|hook success" "$SESSION"
# Baseline: <30 per session
```

### 2. compose-commands.sh line count
```bash
wc -l ~/.claude/hooks/compose-commands.sh
# Baseline: 384 lines (WorldAI version, restored 2026-04-06)
# Alert if >450 — check what was added
diff ~/.claude/hooks/compose-commands.sh ~/worldarchitect.ai/.claude/hooks/compose-commands.sh
```

### 3. Skill count
```bash
ls ~/.claude/commands/*.md 2>/dev/null | wc -l
# Baseline: ~200 after marketplace removal (2026-04-05)
# Alert if >220 — check what was added
```

### 4. MCP server count
```bash
# Count connected servers from deferred tools
# Baseline: 4 servers after trim (ddg-search, filesystem, perplexity-ask, worldarchitect)
# Plus: mcp-agent-mail (global), slack (official plugin)
```

### 5. Compaction guard effectiveness
```bash
cat ~/.claude/compaction-guard.log | tail -20
# Look for: BLOCKED vs ALLOWED ratio
# PreCompact hook blocks ~2% on v2.1.77; check if v2.1.92 improves
```

### 6. Session compaction rate
```bash
# Compare recent session compaction intensity
for f in $(ls -t ~/.claude/projects/*/*.jsonl | head -5); do
  c=$(grep -c compact_boundary "$f" 2>/dev/null || echo 0)
  l=$(wc -l < "$f")
  echo "$(basename $f | cut -c1-8): ${c} compactions / ${l} lines"
done
```

## Known Overhead Sources (as of 2026-04-06)

| Source | Per-turn cost | Status |
|--------|--------------|--------|
| Skills list (~200 skills) | ~8-10K tokens | Reduced from ~370 (marketplace removed) |
| UserPromptSubmit.sh | ~200 bytes | Low impact |
| compose-commands.sh | ~500-2000 bytes | Trimmed from 28KB to 16KB |
| mem0_recall.py | ~500 bytes (3 memories) | bd-cx07: needs optimization |
| MCP tool names (deferred) | ~1K tokens | Reduced from ~71 to ~40 tools |
| CLAUDE.md files | Variable | Loaded per-turn by Claude Code core |
| System prompt + agents | ~26K tokens | Fixed, cannot reduce |

## Red Flags

- compose-commands.sh growing past 400 lines (AO-specific logic leaking into user scope)
- New MCP servers appearing without explicit install
- Hook output exceeding 5KB per invocation
- Compaction rate increasing vs baseline (0.29/100 user msgs as of 2026-04-05)
- New UserPromptSubmit hooks added without early-exit conditions
