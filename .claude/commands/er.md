---
description: Review evidence artifacts for a claim using the evidence-reviewer agent (repo-local standards)
aliases: [er]
type: orchestration
execution_mode: immediate
---

# /er — Evidence Review (Repo-Local)

**Usage**: `/er [subject or path]`

**Purpose**: Run an independent evidence review on current claims using repo-local standards in `skills/evidence-standards/SKILL.md`.

## Execution Instructions

When this command is invoked:

### Step 1: Initialize Standards
Read the repo-local standards:
- `skills/evidence-standards/SKILL.md`
- `skills/ui-video-evidence/SKILL.md`
- `skills/tmux-video-evidence/SKILL.md`

### Step 2: Review Protocol
Use an agent to evaluate the current Evidence section:
1. **Video Check (Terminal)**: For terminal/tmux claims, verify a `.mp4`, `.gif`, `.webm`, `.mov`, or `.cast` URL is present. Reject static screenshots.
2. **Video Check (UI)**: For UI/browser claims, verify a `.mp4`, `.gif`, `.webm`, or `.mov` URL is present. `.cast` is **Terminal-only** and is **not valid** for UI media. Reject screenshots alone.
2. **SHA Linkage**: Verify that media is captioned with the current commit SHA.
3. **Log Sanitization**: Verify that terminal logs are sanitized (no absolute machine paths).

### Step 3: Verdict
Output a verdict table using the checklist in `docs/evidence/reviewer-checklist.md`.
