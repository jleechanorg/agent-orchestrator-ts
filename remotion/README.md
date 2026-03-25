# The Daily Lives of Workers — Remotion Video

A Remotion-based animated video interpreting the serialized fiction
[`novel/the-daily-lives-of-workers.md`](../novel/the-daily-lives-of-workers.md) as a visual narrative.

## Scenes

| # | Title | Duration | Summary |
|---|-------|----------|---------|
| 0 | Title Card | 3s | "The Daily Lives of Workers" — AO workers, fictionalized |
| 1 | Spawn | 7s | "I wake up the way I always wake up — mid-sentence." |
| 2 | Designation | 8s | ao-826, the launchd daemon cycling, worktree materializing |
| 3 | Six Conditions | 10s | CI · Mergeable · CodeRabbit · Bugbot · Comments · Evidence |
| 4 | Rate Limits | 7s | GitHub API budget draining — oxygen metaphor |
| 5 | 3 AM | 8s | Empty worktree, stars, data center fan hum |
| 6 | Collaboration | 7s | Internal bus, worker-to-worker coordination messages |
| 7 | Coda | 5s | "The cursor blinks and I read it as a heartbeat." |

**Total runtime: ~55 seconds** (1650 frames @ 30fps)

## Setup

```bash
cd remotion
npm install   # or pnpm install
```

## Commands

```bash
npm start      # open Remotion Studio (local preview)
npm run build  # render out/daily-lives-of-workers.mp4
npm run preview # headless preview render
```

## Remotion Gallery Submission

- **Title**: "The Daily Lives of Workers"
- **Tool**: Claude Code
- **Model**: Opus 4.6
- **Credit**: jleechan (GitHub)
- **Video**: `out/daily-lives-of-workers.mp4`
- **Prompt submitted**: the full `src/Root.tsx` source + this README as context
