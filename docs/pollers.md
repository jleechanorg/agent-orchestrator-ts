# Pollers — Automated Work Discovery and Session Spawning

## Overview

Pollers are plugins that continuously scan external systems (GitHub PRs, issue trackers, work queues) for actionable work items and automatically spawn fix sessions to address them.

**Poller Manager** (`packages/core/src/poller-manager.ts`) orchestrates all configured pollers:
- Polls on configurable intervals
- Prevents duplicate sessions
- Enforces respawn caps to prevent spam
- Routes work items to spawned agent sessions

## Configuration

Pollers are configured per-project under `projects.<name>.pollers`:

```yaml
projects:
  my-repo:
    repo: org/my-repo
    
    # Poller configuration
    pollers:
      github-pr:
        type: github-pr           # Plugin type
        enabled: true             # Enable/disable this poller
        interval: 5m              # Poll interval
        agent: worker             # Agent role for spawned sessions
        respawnCap:
          max: 10                 # Max sessions per work item
          window: 12h             # Time window for cap
        promptTemplate: |         # Optional prompt template
          Fix PR: {{url}}
          Title: {{title}}
```

## Pollers

### GitHub PR Poller (`github-pr`)

Scans GitHub for open PRs and spawns fix sessions for non-green PRs with CodeRabbit CHANGES_REQUESTED.

**Plugin:** `packages/plugins/poller-github-pr`

**Features:**
- Queries open PRs via `gh pr list`
- Detects CodeRabbit CHANGES_REQUESTED reviews
- Checks CI status (passing/failing)
- Rate limit handling with REST fallback
- Respawn cap: prevents spawning > N sessions per PR per time window

**Work Item Priority:**
- Priority 1: CI failing + changes requested
- Priority 2: CI passing + changes requested

**Configuration:**

```yaml
pollers:
  github-pr:
    type: github-pr
    enabled: true
    interval: 5m
    respawnCap:
      max: 10
      window: 12h
```

**Prompt Template Variables:**
- `{{url}}` — PR URL
- `{{title}}` — PR title
- `{{id}}` — Work item ID (e.g., `pr-123`)

## Respawn Cap

Respawn caps prevent infinite spawning of sessions for the same work item.

**Format:**
```yaml
respawnCap:
  max: 10           # Max 10 spawns
  window: 12h       # Per 12-hour window
```

**Behavior:**
- Tracks spawn count per work item
- Resets window on expiration
- Skips spawning if cap exceeded
- Allows different caps per poller/project

**Default (if not configured):**
- No cap (unlimited spawns)

## Integration

### Lifecycle Integration

Pollers are managed by the Poller Manager, which runs alongside the Lifecycle Manager:

1. **Poller Manager** polls at configured intervals
2. **Queries work items** from enabled pollers
3. **Checks for duplicate sessions** via SessionManager
4. **Enforces respawn caps**
5. **Spawns sessions** for new work items
6. **Tracks metrics** (spawns, skips, errors)

### Session Manager Handoff

When a poller spawns a session:

```typescript
const session = await poller.spawnSession(workItem, projectId, spawnConfig);
```

The spawned session receives:
- Work item context (URL, title, reasons)
- Poller-enriched prompt
- Agent and branch configuration
- Issue ID tracking (for deduplication)

## Respawn Cap Examples

### Example 1: Weekly limit

Max 5 sessions per PR per week:

```yaml
respawnCap:
  max: 5
  window: 7d
```

### Example 2: Hourly limit

Max 1 session per PR per hour (prevents rapid retry loops):

```yaml
respawnCap:
  max: 1
  window: 1h
```

### Example 3: No cap

Unlimited spawns (not recommended):

```yaml
# Omit respawnCap entirely
```

## Monitoring

The Poller Manager records metrics:

- `poller.poll` — Poll execution (success/failure)
- `poller.spawn` — Session spawn (success/failure)
- `poller.respawn_cap_exceeded` — Cap enforcement events

Check orchestrator logs for:
- Rate limit errors (triggers REST fallback)
- Respawn cap skips
- Session spawn failures

## Troubleshooting

### No sessions being spawned

1. Check if poller is `enabled: true`
2. Verify `interval` is set (default: none = disabled)
3. Check orchestrator logs for `poller.poll` errors
4. Verify GitHub token has PR read access

### Sessions spawning too frequently

1. Increase `interval` (e.g., `5m` → `15m`)
2. Reduce `respawnCap.max` (e.g., `10` → `3`)
3. Extend `respawnCap.window` (e.g., `12h` → `24h`)

### Rate limit errors

1. Poller uses exponential backoff (up to 30s)
2. Falls back to REST API after 3 GraphQL retries
3. Check GitHub rate limit: `gh api rate_limit`

## References

- **Config:** `projects.<name>.pollers` in `agent-orchestrator.yaml`
- **Code:** `packages/core/src/poller-manager.ts`
- **Plugin:** `packages/plugins/poller-github-pr`
