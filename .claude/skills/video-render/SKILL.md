# Video Render Skill — AO Novel MP4 Pipeline

Renders `novel/the-daily-lives-of-workers.md` as an animated MP4 using Remotion, then uploads to Google Drive.

## Prerequisites

```bash
# Authenticated already (check with):
gog auth list
# Should show jleechan@gmail.com with drive scope

# Remotion deps installed:
cd remotion && npm install
```

## One-liner

```bash
bash scripts/render-novel-video.sh
```

## What it does

1. **Parse** `novel/the-daily-lives-of-workers.md` — extracts title, date, scene headings, and prose paragraphs
2. **Generate** `remotion/src/Root.tsx` — a parameterized template with the same 7-scene structure as the reference (Title → Spawn → Designation → Six Conditions → Rate Limits → 3AM → Collaboration → Coda), substituting actual prose from the novel
3. **Render** — `cd remotion && npm run build` → `out/daily-lives-of-workers.mp4`
4. **Upload** — `gog drive upload out/daily-lives-of-workers.mp4 --name "daily-lives-$(date +%Y-%m-%d).mp4"`
5. **Output** — Drive share URL printed to stdout

## Scene structure (matches reference video)

| Sequence | Duration | Visual style |
|----------|----------|--------------|
| 0 — Title Card | 3s | Centered title + date |
| 1 — Spawn | 7s | Monospace text, line-by-line fade |
| 2 — Designation | 8s | Split: text left + launchd daemon SVG right |
| 3 — Six Conditions | 10s | Flying condition pills (CI · Mergeable · CR · Bugbot · Comments · Evidence) |
| 4 — Rate Limits | 7s | Animated rate limit bar + counter |
| 5 — 3AM | 8s | Star field + centered text |
| 6 — Collaboration | 7s | Worker network diagram + message log |
| 7 — Coda | 5s | Fading serif text |

**Total: ~55 seconds**

## Color palette

```
BG=#0d1117   TEXT=#e6edf3   ACCENT=#58a6ff   DIM=#8b949e
GREEN=#3fb950   YELLOW=#d29922   RED=#f85149
```

## Parameters from novel markdown

The script extracts:
- **title**: first `# Heading` in the file
- **date**: `YYYY-MM-DD` parsed from filename or first paragraph
- **scene N text**: prose paragraphs, one per scene (up to 7 scenes, excess goes to Coda)

## Drive upload

Uses `gog drive upload` — authenticated already for `jleechan@gmail.com`.
Existing file ID: `1k5JmkmTLcdqfsk3mye2nFbNSLCUiOmAk` ("The Daily Lives of Workers.mp4")

To upload as new file (with timestamp):
```bash
gog drive upload out/daily-lives-of-workers.mp4 --name "daily-lives-$(date +%Y-%m-%d).mp4"
```

## Troubleshooting

**gog not authenticated:**
```bash
gog auth add you@gmail.com --services gmail,calendar,drive,contacts,docs
```

**Remotion build fails:**
```bash
cd remotion && npm install && npm start  # test preview first
```

**No new MP4 generated (same content):**
The script regenerates `Root.tsx` every time. If you see the old content, check the novel markdown has updated text.
