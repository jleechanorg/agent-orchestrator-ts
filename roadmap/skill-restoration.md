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
- Archive remains at **`~/.claude/skills/_archive/loose-md/`** for history (optional delete if you need space; see that folder’s `README.md`).

## Optional follow-ups (done 2026-04-05)

1. **Codex** — Replaced broken symlinks in **`~/.codex/skills/`** that pointed at removed **`~/.claude/skills/*.md`** paths:
   - `harness-engineering.md` → **`~/.claude/skills/harness-engineering/SKILL.md`**
   - `openclaw-diagnostics.md` → **`~/.claude/skills/openclaw-diagnostics/SKILL.md`**
   - `skeptic-agent.md` → **`~/.claude/skills/skeptic-agent/SKILL.md`**
   - `evolve_loop.md` (was a plain file) → symlink to **`~/.claude/skills/evolve-loop/SKILL.md`**; prior file saved as **`evolve_loop.md.bak-20260405`** in `~/.codex/skills/`.
   - `nextsteps.md` was already valid (points at **`~/.openclaw/.claude/skills/nextsteps.md`**); left unchanged.
2. **Archive README** — Updated **`~/.claude/skills/_archive/loose-md/README.md`** with canonical paths and retention note.
