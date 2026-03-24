# Anti-Gravity Super Orchestrator — MCP Server Design

**Date**: 2026-03-24
**Status**: Draft
**Owner**: agento

---

## Background

AO today runs as a CLI tool with tmux-based worker sessions, a lifecycle-manager polling loop, and a launchd daemon. Workers are dispatched via `ao spawn` or the poller-manager. There is no programmatic API — external clients (Slack bots, web dashboards, other agents) must shell out to the `ao` CLI or parse stdout.

This design specifies an **MCP server** that exposes the AO orchestration engine as a first-class programmatic interface. Any MCP client (Claude Code, Claude API apps, Cursor, Gemini CLI) can enqueue work, check status, and receive structured reports from the orchestrator.

---

## Goals

1. Expose AO queue, routing, and session management as MCP tools callable by any MCP client
2. Enforce single-thread control via a machine-wide mutex/lease lock
3. Run as a launchd daemon (always-on, respawn on crash)
4. Support durable, idempotent operations with recovery from crashes
5. Poll conversation sources and report to callers via registered webhooks/callbacks
6. Route work to multi-repo, multi-worktree AO sessions
7. Explicitly place inference: minimal deterministic logic in-server; heavy reasoning delegated to AO workers

---

## Non-Goals

- Re-implement the AO runtime (tmux session management, lifecycle-manager) — those remain unchanged
- Replace the existing `ao` CLI — this is an additive API layer
- Run heavy LLM inference inside the MCP server process

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  MCP Clients (Claude Code, Claude API, Cursor, Gemini CLI)  │
│     ↕ stdio / SSE transport                                 │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  antigravity-mcp-server (TypeScript, Node.js)       │   │
│  │  ┌─────────────┐  ┌──────────┐  ┌────────────────┐  │   │
│  │  │ Queue API   │  │ Poller   │  │ Routing Engine │  │   │
│  │  │ (in-memory  │  │ Loop     │  │ (deterministic │  │   │
│  │  │  + SQLite)  │  │          │  │  rule-based)   │  │   │
│  │  └─────────────┘  └──────────┘  └────────────────┘  │   │
│  │         ↕                  ↕                         │   │
│  │  ┌──────────────────────────────────────────────┐    │   │
│  │  │  AO Core (lifecycle-manager, session store,  │    │   │
│  │  │   ao spawn, poller-manager — unchanged)       │    │   │
│  │  └──────────────────────────────────────────────┘    │   │
│  └─────────────────────────────────────────────────────┘   │
│                          ↕                                 │
│  ┌────────────┐   ┌────────────────┐  ┌────────────────┐  │
│  │  tmux      │   │  MCP Agent Mail │  │  GitHub API     │  │
│  │  sessions  │   │  server         │  │  (PR comments,  │  │
│  └────────────┘   └────────────────┘  │  issues)        │  │
│                                       └────────────────┘  │
└─────────────────────────────────────────────────────────────┘
         ↑ launchd daemon (always-on, KeepAlive)
         ↕ machine-wide mutex: ~/.agento-lock/mcp-server.lock
```

---

## Component: Global Mutex / Lease Lock

### Mechanism
- **File-based machine-wide lock** at `~/.agento-lock/mcp-server.lock`
- Implementation: `async-lock` npm package or Node.js `flock(2)` via `fcntl`
- Lock file contains `{ pid, startTime, instanceId }` JSON payload
- On startup: acquire exclusive lock. If held by another process, exit with code 42 (SIUSER — "already running")
- **Lease renewal**: every 30 seconds, re-acquire to detect stale locks (crashed holder)
- On graceful shutdown: release lock and delete file

### Why file-based
- Survives crash of the MCP server process
- Works across multiple users on the same machine (different `$HOME`)
- No external dependency (no Redis, no etcd)

### Enforcement in launchd
- The launchd plist uses `KeepAlive: SuccessfulExit=false` — if the process dies it restarts
- The lock prevents a second launchd instance from starting a second server
- `start-all.sh` checks lock before spawning — idempotent

---

## Component: Queue API (MCP Tools)

All tools are idempotent. Enqueue returns an `itemId` — callers use this to query/cancel.

### Tools

| Tool | Description |
|------|-------------|
| `enqueue` | Add a work item to the queue with routing metadata |
| `list` | List queued, active, and completed items (with pagination) |
| `get` | Get full details for one item by ID |
| `cancel` | Mark an item as cancelled; signals worker to stop |
| `pause` | Pause a running item (preserves state for resume) |
| `resume` | Resume a paused item |
| `status` | Aggregate system status (queue depth, active sessions, lock holder) |
| `route` | Explicitly route a queued item to a specific repo/worktree/session |
| `subscribe` | Register a webhook/callback URL for status changes on an item |

### Enqueue Payload

```typescript
interface EnqueueRequest {
  task: string;                  // Natural language task description
  repo: string;                  // e.g. "jleechanorg/agent-orchestrator"
  branch?: string;               // Optional: branch name (auto-created if omitted)
  worktree?: string;             // Optional: worktree path hint
  sessionPrefix?: string;        // Optional: "ao", "jc", "wa", etc.
  priority?: "low" | "normal" | "high" | "urgent";  // Default: "normal"
  callbackUrl?: string;          // Optional: POST here on state change
  idempotencyKey?: string;       // Optional: deduplicate by key
  metadata?: Record<string, string>;  // Arbitrary caller-supplied tags
}
```

### Enqueue Response

```typescript
interface EnqueueResponse {
  itemId: string;    // UUID — use with get/cancel/pause/status
  queuePosition: number;
  estimatedWaitItems: number;  // items ahead in same priority band
  createdAt: string;  // ISO 8601
}
```

### List Response

```typescript
interface ListResponse {
  items: Array<{
    itemId: string;
    task: string;
    repo: string;
    state: "queued" | "dispatched" | "running" | "paused" | "completed" | "failed" | "cancelled";
    priority: string;
    createdAt: string;
    updatedAt: string;
    sessionName?: string;   // Set once dispatched
    error?: string;         // Set on failed
  }>;
  pagination: { cursor?: string; hasMore: boolean; total: number };
}
```

### Idempotency
- If `idempotencyKey` is provided and matches an existing item in `queued` or `dispatched` state, return the existing `itemId` instead of creating a duplicate
- `cancel` on a non-existent item: return success (idempotent)
- `pause` on a non-running item: return error with current state

---

## Component: Polling Loop

### Sources (configurable, all enabled by default)

1. **MCP Agent Mail** — poll `MCP_AGENT_MAIL_URL` for new inbound messages; parse `instruction` field; enqueue derived tasks
2. **GitHub PR conversations** — poll GitHub API for new PR comments, review threads, and issue activity on tracked repos; emit structured `ConversationEvent` reports to registered subscribers

### Polling Intervals (configurable)

| Source | Default interval |
|--------|-----------------|
| MCP Agent Mail | 15 seconds |
| GitHub PR comments | 60 seconds |
| GitHub review threads | 60 seconds |
| GitHub issues | 60 seconds |

### ConversationEvent Report

```typescript
interface ConversationEvent {
  source: "github-pr-comment" | "github-review-thread" | "github-issue" | "mcp-mail";
  repo: string;
  itemId?: string;       // Linked AO work item, if any
  actor: string;         // GitHub user or mail sender
  body: string;         // Truncated to 500 chars
  url: string;          // Direct link to the comment/thread
  timestamp: string;     // ISO 8601
  deliveredVia?: string; // callbackUrl if already posted
}
```

### Delivery
- Events are queued in the same SQLite store as work items
- If `callbackUrl` is registered for the item (or globally), POST the event there
- If delivery fails, retry with exponential backoff (1s, 2s, 4s, 8s, max 60s) for up to 1 hour
- After 1 hour, mark event as `undelivered` — operator can inspect via `list --events undelivered`

---

## Component: Routing Engine

### Inference Placement Decision

**The routing engine does NOT run LLM inference.**

It applies deterministic, rule-based routing:

1. **By repo** → route to the AO session pool for that repo (one pool per tracked repo)
2. **By priority** → urgent/high items dispatched first; queue is priority-sorted
3. **By sessionPrefix** → if caller specified a prefix, prefer that pool
4. **By worktree availability** → pick the worktree with most free slots
5. **By session health** → skip sessions in `stuck` or `dead` state

If rules are insufficient to make a routing decision, the item stays `queued` and a human operator is notified via the configured notifier.

### Multi-Repo, Multi-Worktree

- Each tracked repo has its own worktree pool managed by the existing runtime-tmux plugin
- The routing engine tracks per-repo capacity (total slots, free slots) in-memory
- A `route` tool call overrides automatic routing for a specific item

---

## Component: Durability and Recovery

### SQLite Store

All persistent state lives in `~/.agent-orchestrator/mcp-server.db`:

```sql
CREATE TABLE work_items (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT UNIQUE,
  task TEXT NOT NULL,
  repo TEXT NOT NULL,
  branch TEXT,
  worktree TEXT,
  session_prefix TEXT,
  priority TEXT DEFAULT 'normal',
  state TEXT DEFAULT 'queued',
  session_name TEXT,
  error TEXT,
  callback_url TEXT,
  metadata TEXT,  -- JSON
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE conversation_events (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  repo TEXT NOT NULL,
  item_id TEXT REFERENCES work_items(id),
  actor TEXT NOT NULL,
  body TEXT,
  url TEXT,
  delivered_via TEXT,
  delivery_state TEXT DEFAULT 'pending',  -- pending|delivered|undelivered
  last_delivery_attempt TEXT,
  delivery_attempts INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,
  item_id TEXT REFERENCES work_items(id),
  callback_url TEXT NOT NULL,
  events TEXT NOT NULL,  -- JSON array of event types
  created_at TEXT NOT NULL
);
```

### Recovery on Startup

1. Acquire lock — if fails, exit (another instance is running)
2. Open SQLite DB — if missing, create schema
3. Scan `work_items` for items in `dispatched` or `running` state — set to `queued` (orphaned by prior crash)
4. Start polling loop and MCP server

---

## Component: MCP Server Transport

### Primary: stdio
- Standard MCP transport — single instance per machine, started by launchd
- Clients connect via `mcp__ai-universe-backend-dev__*` or direct stdio

### Secondary: SSE (HTTP)
- Optional HTTP+SSE endpoint for web clients
- Enabled via `--sse-port <N>` flag
- CORS: restricted to localhost by default
- Auth: `AGENTO_MCP_API_KEY` env var — bearer token validation

### MCP Resources

| Resource | URI |
|----------|-----|
| Queue status | `agento://queue/status` |
| Item detail | `agento://item/{itemId}` |

### MCP Prompts

| Prompt | Description |
|--------|-------------|
| `assess-pr` | Given a PR URL, inspect queue state and AO session health, return routing recommendation |

---

## Component: launchd Daemon

### Plist: `com.agento.antigravity-mcp-server.plist`

- Installed via `scripts/setup-launchd.sh` (extends existing launchd setup pattern)
- `ProgramArguments`: `["node", "<repo>/packages/mcp-antigravity/dist/index.js", "--config", "<config-path>"]`
- `KeepAlive: SuccessfulExit=false` — restart on crash, not on clean exit
- `EnvironmentVariables`: `HOME`, `PATH`, `MCP_AGENT_MAIL_URL`, `AGENTO_MCP_API_KEY`, `GITHUB_TOKEN`
- `StandardOutPath`: `~/.agent-orchestrator/logs/antigravity-mcp-server.log`
- `StandardErrorPath`: same
- `RunAtLoad`: `true`

---

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Lock held by another process | Exit 42 — launchd will not restart (another instance already owns it) |
| Lock file corrupt | Delete and re-acquire |
| SQLite write failure | Log error, exit 1 (crash-and-restart triggers recovery) |
| MCP Agent Mail unreachable | Log warning, continue polling other sources |
| GitHub API rate limited | Back off exponentially, log warning |
| AO spawn fails | Mark item `failed`, notify via callback, increment failure counter |
| Callback delivery fails | Retry with backoff; after 1 hour mark `undelivered` |

---

## Configuration

`agent-orchestrator.yaml` additions:

```yaml
mcpServer:
  enabled: true
  ssePort: 3100          # 0 = disabled; default 0 (stdio only)
  apiKey: "${AGENTO_MCP_API_KEY}"
  lockPath: "~/.agento-lock/mcp-server.lock"
  lockLeaseSeconds: 30

pollingSources:
  mcpMail:
    enabled: true
    intervalSeconds: 15
    url: "${MCP_AGENT_MAIL_URL}"
  github:
    enabled: true
    intervalSeconds: 60
    repos:
      - "jleechanorg/agent-orchestrator"
      - "jleechanorg/jleechanclaw"
    eventTypes:
      - "pr-comment"
      - "review-thread"
      - "issue-comment"

queue:
  maxConcurrentPerRepo: 3
  maxConcurrentTotal: 10
  retryAttempts: 3

notifiers:
  mcpMail:
    url: "${MCP_AGENT_MAIL_URL}"
```

---

## Package Structure

```
packages/
  mcp-antigravity/
    src/
      index.ts              # MCP server entry (stdio + SSE)
      queue/
        queue-store.ts      # SQLite-backed in/outbox
        queue-api.ts        # MCP tool implementations
        idempotency.ts      # Idempotency key logic
      polling/
        polling-loop.ts     # setInterval orchestrator
        mcp-mail-source.ts  # MCP Agent Mail poller
        github-source.ts    # GitHub conversation poller
      routing/
        routing-engine.ts   # Deterministic rule-based router
        capacity-tracker.ts # Per-repo/free-slot tracking
      lock/
        machine-lock.ts     # File-based mutex/lease
        lease-renewer.ts    # Background lease renewal
      daemon/
        launchd-plist.ts    # Plist generation
        start-script.ts     # start-antigravity-mcp.sh
      types.ts              # Shared interfaces
    test/
      queue.test.ts
      routing.test.ts
      lock.test.ts
      polling.test.ts       # Mock polling sources
    package.json
```

---

## Security Considerations

- SSE endpoint: bearer token required (`AGENTO_MCP_API_KEY`)
- `GITHUB_TOKEN` used only for GitHub API polling — read-only scopes sufficient
- Lock file stored in `~/.agento-lock/` — user-only read/write (mode 0700)
- SQLite DB stored in `~/.agent-orchestrator/` — user-only access
- No secrets written to logs; env vars redacted in trace output

---

## Testing Strategy

- **Unit**: queue idempotency, routing engine rules, lock acquire/release
- **Integration**: SQLite schema migrations, polling sources with recorded responses
- **E2E**: spawn MCP server via launchd, connect real MCP client, enqueue a real `ao spawn` task, verify session created and item state transitions to `completed`

---

## Open Questions (to resolve during implementation review)

1. Should `subscribe` deliver via SSE push to connected clients, outbound HTTP POST, or both?
2. Should the MCP server be a separate npm package (`@jleechanorg/agento-mcp`) or part of `@jleechanorg/ao-core`?
3. Should GitHub conversation polling be keyed by `itemId` (only poll repos with active items) or always-on for all configured repos?
4. Is 30-second lease renewal aggressive enough, or should it be shorter (10s) for faster stale-lock detection?
