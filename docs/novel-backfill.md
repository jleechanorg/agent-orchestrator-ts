# Serialized Novel Backfill Guide

This repo keeps the ongoing AO fiction in:

- `novel/the-daily-lives-of-workers.md`

## Backfilling older entries

Use the new backfill helper to append generated entries from historical worker/PR events:

```bash
pnpm run novel:backfill \
  -- --file novel/the-daily-lives-of-workers.md \
  --events specs/novel/older-worker-events.json \
  --count 5 \
  --words 1000
```

Options:
- `--file` destination novel markdown file
- `--events` JSON array of events (`worker`, `trigger`, `topic`, `context`)
- `--count` number of entries to generate
- `--date-prefix` prefix for section headings (default: "Backfill Day ")
- `--words` words of generated prose for each section

The helper is deterministic and inserts entries in this form:

- `## Backfill Day N — <worker>`
- `### POV: <worker> — <context> (<trigger>)`
- `--words` words of generated prose for each section

A future enhancement is to wire this helper behind lifecycle-worker event hooks so entries are generated automatically on worker reaps or PR open events.

## Daily novel + repo activity job

### One-shot

```bash
pnpm run novel:daily
```

This aggregates:
- local commit activity from the current branch (last 24h)
- open/merged PR snapshots
- recent workflow run outcomes
- recent novel section history

Then it appends one daily section into `novel/the-daily-lives-of-workers.md`.

### Launchd installation

Install daily scheduling from the central setup path:

```bash
pnpm run launchd:install
```

This installs two launchd agents via `scripts/setup-launchd.sh`:
- `ai.agento.lifecycle-all` (existing lifecycle orchestration)
- `ai.agento.novel-daily` (runs daily novel aggregation at 06:00 local time)

To rerun after updates:

```bash
pnpm run launchd:install
```

To inspect status:

```bash
launchctl print gui/$(id -u)/ai.agento.novel-daily
launchctl print gui/$(id -u)/ai.agento.lifecycle-all
```