---
name: ui-video-evidence
description: How to record captioned browser/UI evidence GIFs that prove visual behavior and user flows ran correctly
---

# UI Video Evidence for Visual Verification

## Purpose

Prove that UI behavior, visual state, and click flows occurred as claimed. A GIF with visible URL, timestamps, and action context is tamper-evident in a way screenshots alone are not.

## When This Is Required

Use UI video evidence (in addition to tmux video) whenever your claim involves:

- A rendered UI component or page
- A click flow, form submission, or navigation
- Visual state change (modal open, error shown, data loaded)
- "Works in browser" or "UI looks correct" claims
- Any test that drives a real browser

## Tool Options

### Option 1 — Claude-in-Chrome GIF (preferred for agent sessions)

```
mcp__claude-in-chrome__gif_creator
```

Built into the harness. Records Chrome tab interactions directly.

**Usage pattern:**
1. Start gif recording
2. Navigate to the page under test (URL must be visible in frame)
3. Perform the action being claimed
4. Capture the resulting state
5. Stop and save with a meaningful filename

### Option 2 — Kap (preferred for native app / full-screen flows)

```bash
brew install --cask kap
```

Open Kap → select region → record → export as GIF.

### Option 3 — ffmpeg (CI / headless environments)

```bash
# Record X11 display (Linux CI)
ffmpeg -video_size 1280x720 -framerate 10 -f x11grab -i :99 \
  -t 30 /tmp/<work_name>.mp4

# Convert to GIF
ffmpeg -i /tmp/<work_name>.mp4 -vf "fps=10,scale=1280:-1" \
  /tmp/<work_name>.gif
```

## Mandatory Evidence Frames

Every UI evidence GIF MUST show these frames in order:

| # | Frame | What must be visible |
|---|-------|---------------------|
| 1 | **URL + Page Load** | Full browser URL bar showing the route being tested |
| 2 | **Before State** | Initial state before the action (empty form, list count, etc.) |
| 3 | **Action** | The click, input, or navigation being performed |
| 4 | **After State** | Result of the action (success message, data change, navigation) |
| 5 | **Git Commit Link** | Terminal pane or overlay showing `git rev-parse HEAD` |

## Caption / Annotation Requirements

The GIF must be self-explanatory to a reviewer who has no context:

- **URL visible in frame** — don't crop out the address bar
- **Route matches claim** — if claiming `/campaign/123` works, that URL must appear
- **Timestamps** — use browser devtools Network tab or console timestamps when timing matters
- **No pre-recorded state** — if the test creates data, show the creation step, not just the result

## Git Linkage (MANDATORY)

UI evidence must be tied to a commit, same as terminal evidence. Do one of:

1. **Split screen**: show terminal with `git rev-parse HEAD` alongside the browser
2. **Console log**: `console.log('SHA:', '<git-sha>')` visible in browser devtools
3. **Page element**: render the commit SHA in the UI during test mode (e.g. footer `data-commit` attribute)

```bash
# Quick split-screen approach with tmux
tmux split-window -h "watch -n1 git rev-parse HEAD"
# Then record both panes with asciinema or screen capture
```

## Evidence Script Template

```bash
#!/bin/bash
# UI Evidence Setup — <PR/Work Item>
set -e

echo "=== UI EVIDENCE: Git Provenance ==="
git rev-parse HEAD
git branch --show-current
git log --oneline origin/main..HEAD
echo ""

echo "=== Starting UI evidence recording ==="
echo "URL under test: <URL>"
echo "Claim: <what behavior this proves>"
echo "Commit: $(git rev-parse HEAD)"
echo ""

# Launch browser to the page
# (agent: use mcp__claude-in-chrome__navigate + gif_creator)
# (human: open browser manually, start Kap)

echo "=== Post-recording SHA check ==="
echo "SHA unchanged: $(git rev-parse HEAD)"
```

## Reviewer Checklist

A reviewer of UI evidence should verify:

1. **URL visible**: Address bar or route shown — matches the claimed page
2. **Before/after states**: Both shown — not just the success state
3. **Action visible**: The triggering interaction is in the recording
4. **Git linkage**: SHA tied to the recording via split-screen or console
5. **No jump cuts**: GIF plays continuously without suspicious edits
6. **Data is real**: If form was submitted, network tab shows real API call

## Anti-Patterns

| Don't | Do instead |
|-------|-----------|
| Show only the success state | Show before → action → after |
| Crop out the URL bar | Keep browser chrome visible |
| Use a pre-seeded DB and claim it proves creation | Show the creation step in the recording |
| Record without git SHA visible | Add terminal split or console log |
| Use a screenshot instead of GIF for flows | GIF proves the flow happened; screenshot proves only a moment |

## Embedding in PRs

```markdown
## UI Evidence

![<description>](/path/to/evidence.gif)

**Commit**: `<git-sha>`
**URL tested**: `<url>`
**Claim**: <what this proves>
```
