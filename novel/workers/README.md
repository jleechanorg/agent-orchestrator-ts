# novel/workers — Per-Worker Novel Entry Files

Each AO worker session generates its own individual novel entry file in this directory.

## File Format

```markdown
# {session-id} — {theme/branch-name}

*PR: #{pr-number} | Date: {date} | Status: {merged/open/closed}*

---
{narrative prose, 100-300 words, in the voice of that worker, grounded in real work}
```

## Naming Convention

- Per-session filename: `{session-id}.md` (e.g., `ao-826.md`, `wc-63.md`)
- Daily aggregate filename: `{YYYY-MM-DD}.md` (e.g., `2026-04-02.md`)
- Session IDs follow the pattern: `{prefix}-{number}` where prefix is `ao`, `jc`, `wa`, `cc`, `ra`, or `wc`

## Generated Entries

Per-worker entries (session-specific prose):
```
node scripts/novel/generate-daily-entry.mjs --session ao-123 --pr 456
```

Daily aggregate entries (separate file per day):
```
node scripts/novel/generate-daily-entry.mjs --daily 2026-04-02
# Or from launchd (canonical setup):
node scripts/novel/generate-daily-entry.mjs --daily "$(date '+%Y-%m-%d')"
```

The script will:
1. Write an individual entry to `novel/workers/{session-id}.md` or `novel/workers/{date}.md`
2. Append a summary to `novel/the-daily-lives-of-workers.md`

## Daily Automated Entries

The `ai.agento.novel-daily` launchd job runs at 06:00 PT daily and generates a new
`novel/workers/{YYYY-MM-DD}.md` file via `--daily` mode. Each file contains:
- The date as title
- A prose narrative of the day's PR activity, generated from real git/gh data
- An atmospheric entry in the serialized fiction voice

Output files are **never overwritten** — if a file for that date already exists, the
script skips silently (idempotent).

## Aggregation

`scripts/novel/aggregate.mjs` reads all `novel/workers/*.md` files and rebuilds
`novel/the-daily-lives-of-workers.md` with:
- Prologue (static, hand-written)
- Chapters (static, hand-written)
- Daily entries sorted by date, assembled from individual worker files

## Sourcing

Rich narrative entries are drawn from:
- `novel/the-daily-lives-of-workers.md` — chapter POV sections and Backfill Day entries
- Real PR/commit data via the GitHub API
