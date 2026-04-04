# ao-spawn-gate

Pre-spawn checklist before approving any AO worker spawn.

## Commands

```bash
gh api rate_limit
tmux list-sessions | wc -l
~/bin/ao status --project agent-orchestrator
~/bin/ao session ls
```

## Thresholds

- `graphql.remaining < 200` → block spawn and warn user.
- `graphql.remaining < 100` → REST fallback exclusively (no GraphQL).
- `core.remaining < 500` → defer non-critical reads/polls.
- active tmux sessions `> 15` → block spawn and defer.
- missing concrete context (no task/issue/PR) → block spawn.

## REST fallback example

```bash
gh api repos/jleechanorg/agent-orchestrator/pulls --method POST   -f title='[agento] ...' -f head='branch' -f base='main' -f body='...'
```
