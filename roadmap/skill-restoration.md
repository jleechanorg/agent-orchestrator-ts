# Skill restoration (2026-04-05)

**Beads:** **bd-pwku** (epic), **bd-ts3r** (user scope), **bd-r8cl** (per-repo index).

## What we did

1. **User scope (`~/.claude/skills/`)** — Restored essentially all `*.md` from `~/.claude/skills/_archive/loose-md/` into **`<name>/SKILL.md`** folders (underscores → hyphens in directory names). Skipped: `README.md`, superseded **`evidence-standards`** (canonical **`evidence-standards/SKILL.md`** already exists), duplicate archive **`harness-engineering`** (content lives under **`harness-engineering/SKILL.md`**).
2. **`nextsteps`** — Canonical copy from **`_archive/loose/nextsteps.md`** → **`~/.claude/skills/nextsteps/SKILL.md`**.
3. **`harness-engineering`** — Moved **`~/.claude/skills/harness-engineering.md`** → **`harness-engineering/SKILL.md`**.
4. **Commands** — Updated **`~/.claude/commands/harness.md`** to reference **`harness-engineering/SKILL.md`**.
5. **This repo** — Removed duplicate loose `*.md` under **`.claude/skills/`**; added **`.claude/skills/README.md`** pointer table; kept **`video-render/SKILL.md`**. **`CLAUDE.md`** links to the index.

## Snapshot

Before changing repo files, a copy of **`roadmap/`** was saved under **`~/Downloads/agent-orchestrator-roadmap-YYYYMMDD-HHMMSS/`**.

## Maintenance

- Edit skills in **user scope** `SKILL.md` paths; avoid reintroducing loose `*.md` copies in the repo skills folder.
- Archive remains at **`_archive/loose-md/`** for history.
