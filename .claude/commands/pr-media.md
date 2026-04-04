# /pr-media — Capture and attach terminal media to PRs

Run the actual capture script, not prose guidance.

```bash
# Capture screenshot of current tmux pane + upload to Gist + post to PR
bash scripts/pr-media.sh

# Dry-run (capture + upload, skip PR comment)
bash scripts/pr-media.sh --test

# With options
bash scripts/pr-media.sh --type screenshot --pr 281 --caption "AO worker showing test pass"
bash scripts/pr-media.sh --type gif           # 5-second clip → GIF (requires ffmpeg + gifski)
bash scripts/pr-media.sh --type video         # 10-second recording (requires ffmpeg)
```

The script (`scripts/pr-media.sh`) implements the **Terminal media** requirement of Evidence Bundle v2 (CLAUDE.md).

## Philosophy (Cursor-style evidence)

Cursor's cloud agents produce **artifacts (videos, screenshots, and logs)** and merge-ready PRs with artifacts so reviewers can validate work without trusting prose alone. The `/pr-media` command automates the capture step so agents attach real terminal proof to every PR.

**Evidence Bundle v2 requires** (CLAUDE.md Evidence Gate strong proof):
- **Terminal media**: screenshot or video URL + caption mentioning `tmux` or `terminal`
- **Caption outside the label line** — the caption must describe what the media shows, not just repeat the label

## Usage

```
/pr-media [--type screenshot|video|gif] [--pr N] [--caption "text"]
```

### Arguments

| Flag | Default | Description |
|------|---------|-------------|
| `--type` | `screenshot` | Media type: `screenshot`, `video`, or `gif` |
| `--pr` | auto-detect | PR number; auto-detected from current branch |
| `--caption` | auto | Caption text; auto-generates if omitted |

### Examples

```
/pr-media
/pr-media --type screenshot
/pr-media --type video --caption "AO worker session showing PR merge confirmation"
/pr-media --type gif
/pr-media --pr 281
```

## Workflow

1. **Capture** — `screencapture` (screenshot) or `ffmpeg` (video/gif) captures the tmux pane
2. **Upload** — file is uploaded to GitHub Gist via `gh gist create` (authenticated, secret by default)
3. **Attach** — GitHub comment is posted on the target PR with the media URL in markdown
4. **Output** — prints the markdown snippet to stdout for copy-paste into PR body

## Prerequisites

```bash
# Required tools (verify they're available):
which screencapture  # macOS built-in: /usr/sbin/screencapture
which ffmpeg         # video/gif: brew install ffmpeg

# GitHub CLI must be authenticated:
gh auth status
```

## Output format

The command prints a markdown snippet suitable for pasting into `## Evidence`:

```
**Terminal media**: https://gist.github.com/USER/XXXXXXXX
tmux pane with screenshot — AO worker showing test pass
```

For PR body use, paste the URL directly under `**Terminal media**:` and add the caption.

## Terminal vs UI media

| Media type | Evidence field | Use when |
|------------|---------------|----------|
| tmux/terminal screenshot, video, or gif | **Terminal media** | CLI behavior, test output, AO session logs |
| App UI, browser, or interactive UI | **UI media** | Visual UX changes, screenshots of UI |

If the capture shows CLI output (test results, logs, terminal), it belongs in **Terminal media**.
If the capture shows an app window or browser UI, use **UI media** instead.

## Anti-patterns (Evidence Gate fails these)

- Caption that only repeats the label (e.g. `**Terminal media**: screenshot of terminal` — no)
- Caption that says "screenshot of terminal" without describing what the terminal shows
- Screenshot of a blank or nearly-empty terminal
- Video longer than 30s (too large for Gist; trim or use gif)

## Gist upload details

- Files are uploaded to GitHub Gist via `gh gist create` — requires `gh auth status` (authenticated)
- Gists are **secret by default** (`GIST_PUBLIC=false`); set `PR_MEDIA_PUBLIC=true` env var for public
- Gist URL format: `https://gist.github.com/USER/HASH` — raw URL: `https://gist.githubusercontent.com/USER/HASH/raw/FILENAME`
- Evidence Gate CI accepts both `gist.github.com` and `gist.githubusercontent.com` URLs
- No expiry — Gists are permanent
