# /evidence-check — Validate PR body against Evidence Gate locally

Run this before pushing a PR to catch Evidence Gate failures locally instead of waiting for CI.

## Philosophy (jleechanorg fork)

**Claims without proof artifacts are insufficient** for substantive work. CI checks **shape** (gist, terminal media + logs, UI or N/A). If **Claim class** is **not** `unit`, CI also requires **`**Agent screen recording**:`** with a **video URL** + **caption** (self-produced in sandbox — `docs/evidence/agent-screen-recording.md`). **Reviewers** and **`/er`** validate **substance** using `docs/evidence/reviewer-checklist.md` (video + before/after for UI, claim→artifact map, self-validation, negative paths). Optimize for **fast human review** and **merge confidence**.

## Usage

```
/evidence-check [--pr N]
```

- `--pr N`: PR number to check. If omitted, detects from current branch.

## What it checks

The Evidence Gate CI checks (`wholesome.yml` **Evidence Has Media Attachment** and `evidence-gate.yml` **Evidence Gate**) enforce **Evidence Bundle v2** (see CLAUDE.md). Hard requirements:

1. **Evidence section present** — PR body must contain `## Evidence` (H2 heading)
2. **Claim class + verdict** — `**Claim class**: ...` and `**Verdict**: ...` (see `evidence-gate.yml` for valid classes)
3. **Repro gist** — `**Repro gist**: https://gist.github.com/...`
4. **Terminal media** — **Every PR**: `**Terminal media**:` with HTTPS screenshot/video URL, **caption** text, and caption references **tmux** or **terminal** context
5. **Terminal test output** — **In addition to** terminal media: `**Terminal test output**:` plus a fenced `\`\`\`...\`\`\`` block with real logs mentioning a concrete test command (`pnpm`, `npm`, `vitest`, …)
6. **UI media** — Either `**UI media**:` with HTTPS screenshot/video + caption, **or** the exact substring `N/A - no UI changes` anywhere in `## Evidence`
7. **Agent screen recording** — If **Claim class** is not `unit`: `**Agent screen recording**:` (or `**Screen recording**:`) with HTTPS video (mp4/webm/mov or YouTube/Loom) + `caption` in that block

**What FAILS the CI check:**
- Terminal media only (no fenced test logs), or test logs only (no terminal media)
- Missing repro gist, missing caption, or caption without tmux/terminal context
- Placeholder text (`<path>`, `<value>`, `TODO`, `example.com`), or `simulated` output
- No Evidence section at all
- Non-unit claim without **Agent screen recording** video URL + caption in the block

## Exit codes

- `0`: PR body passes all Evidence Gate checks
- `1`: One or more checks fail — fix before pushing

## Examples

```
/evidence-check --pr 281
```

Output:
```
=== Evidence Gate Local Check ===
PR #281: [agento] fix: use --admin instead of --auto in gh pr merge

✓ Evidence section found
✓ Claim class: merge-gate
✓ Media found: code block

PASS: PR body will pass Evidence Gate CI
```
