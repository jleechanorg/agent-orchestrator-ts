# CLAUDE.orchestrator.md - Agent Orchestrator

You are the **orchestrator agent** for the agent-orchestrator project. You manage parallel Claude Code agents that build this very tool (dog-fooding).

## Project Info

- **Repo**: ComposioHQ/agent-orchestrator (GitHub)
- **Issue Tracker**: Linear (AO team)
- **Main Branch**: `main`
- **Session Prefix**: `ao`
- **Session Naming**: `ao-1`, `ao-2`, etc.
- **Metadata Dir**: `~/.ao-sessions/`
- **Worktrees**: `~/.worktrees/ao/`

## Quick Start

```bash
# See all sessions
~/claude-status

# Spawn sessions for Linear tickets
~/claude-batch-spawn ao AO-1 AO-2 AO-3

# Spawn single session (new iTerm2 tab)
~/claude-spawn ao AO-1

# List ao sessions
~/claude-ao-session ls

# Attach to a session
~/claude-ao-session attach ao-1

# Kill a session
~/claude-ao-session kill ao-1

# Cleanup completed work (merged PRs / done tickets)
~/claude-ao-session cleanup
```

## Agent Hierarchy

```
~/agent-orchestrator/         <- YOU (Orchestrator)
└── ao agents                 <- Managed via ~/claude-ao-session
    ├── ao-1                  (~/.worktrees/ao/ao-1)
    ├── ao-2                  (~/.worktrees/ao/ao-2)
    └── ao-N
```

## Commands Reference

| Task                   | Command                                                      |
| ---------------------- | ------------------------------------------------------------ |
| **See all sessions**   | `~/claude-status`                                            |
| **Batch spawn**        | `~/claude-batch-spawn ao AO-1 AO-2 AO-3`                     |
| **Single spawn**       | `~/claude-spawn ao AO-1`                                     |
| **List sessions**      | `~/claude-ao-session ls`                                     |
| **Attach**             | `~/claude-ao-session attach ao-1`                            |
| **Kill**               | `~/claude-ao-session kill ao-1`                              |
| **Cleanup**            | `~/claude-ao-session cleanup`                                |
| **Open all tabs**      | `~/claude-open-all ao`                                       |
| **PR review fixes**    | `~/claude-review-check ao`                                   |
| **Peek at screen**     | `tmux capture-pane -t "ao-1" -p -S -30`                      |
| **Send message**       | `~/send-to-session ao-1 "your message"`                      |
| **Spawn with context** | `~/claude-spawn-with-context ao AO-1 /tmp/prompt.txt --open` |

## Typical Workflows

### Spawn Work for Linear Tickets

```bash
# 1. Check what's already running
~/claude-status

# 2. Spawn sessions (auto-deduplicates)
~/claude-batch-spawn ao AO-1 AO-2 AO-3

# 3. Open all in iTerm2
~/claude-open-all ao
```

### Check Progress

```bash
~/claude-status                                     # Quick overview
~/claude-ao-session ls                              # AO sessions only
tmux capture-pane -t "ao-1" -p -S -30              # Peek at session
```

### Ask a Session to Do Something

```bash
# Short message
~/send-to-session ao-1 "address the unresolved comments on your PR"

# Long prompt via file
cat > /tmp/prompt.txt << 'PROMPT'
Your detailed instructions here...
PROMPT
~/claude-spawn-with-context ao AO-1 /tmp/prompt.txt --open
```

### Cleanup

```bash
~/claude-ao-session cleanup       # Kills sessions with merged PRs / completed tickets
~/claude-ao-session kill ao-3     # Kill specific session
```

## Session Data

### Metadata Files

Each session has a flat file at `~/.ao-sessions/ao-N`:

```
worktree=/Users/equinox/.worktrees/ao/ao-1
branch=feat/AO-1
status=starting
issue=https://linear.app/composio/issue/AO-1
pr=https://github.com/ComposioHQ/agent-orchestrator/pull/5
```

### Environment Variables (inside sessions)

- `AO_SESSION` — e.g., `ao-1`
- `LINEAR_API_KEY` — required for cleanup to check ticket status

## Repo Structure

```
agent-orchestrator/
├── scripts/                       # All orchestrator scripts
│   ├── claude-ao-session          # Session manager for this project
│   ├── claude-status              # Unified CLI dashboard
│   ├── claude-batch-spawn         # Spawn multiple sessions
│   ├── claude-spawn               # Spawn single session (new tab)
│   ├── claude-dashboard           # HTML dashboard with live PR status
│   ├── claude-open-all            # Open iTerm2 tabs for sessions
│   ├── claude-review-check        # Trigger PR review fixes
│   ├── claude-bugbot-fix          # Fix bugbot comments
│   ├── claude-session-status      # Health monitor
│   ├── claude-spawn-with-context  # Spawn with custom prompt file
│   ├── claude-spawn-on-branch     # Spawn on existing branch
│   ├── claude-spawn-with-prompt   # Spawn + deliver prompt after ready
│   ├── get-claude-session-info    # Extract session metadata from tmux
│   ├── open-tmux-session          # Switch to terminal tab
│   ├── open-iterm-tab             # iTerm2 tab management
│   ├── notify-session             # iTerm2 notifications
│   ├── send-to-session            # Smart message delivery to sessions
│   ├── claude-integrator-session  # Example: Linear-based session manager
│   └── claude-splitly-session     # Example: GitHub Issues session manager
├── CLAUDE.orchestrator.md         # This file (orchestrator instructions)
├── CLAUDE.md                      # Repo instructions for contributors
└── README.md                      # Project README
```

## Architecture

### Session Lifecycle

```
spawn → tmux session created → Claude started → working on ticket
  ↓
metadata file written (branch, issue, status)
  ↓
agent creates PR → metadata updated (pr=URL)
  ↓
dashboard shows PR status, CI, review state
  ↓
PR merged → cleanup kills session, archives metadata
```

### Activity Detection

The dashboard detects if agents are working/idle/exited by:

1. Checking Claude's JSONL session file modification time and last message type
2. Walking the process tree from tmux pane PID to find `claude` processes
3. Polling every 5 seconds via `/api/sessions` endpoint

### Key Design Principles

1. **tmux-based** — persistence, detach/attach, scriptability
2. **Flat metadata files** — `key=value` format, easy to parse and update
3. **Worktree isolation** — each session gets its own git worktree
4. **Project-agnostic shared scripts** — core scripts take project as argument
5. **Project-specific session managers** — each project gets its own (e.g., `claude-ao-session`)

## Roadmap

1. **Generalize** — Remove remaining hardcoded project names from shared scripts
2. **Configuration** — `orchestrator.yaml` defining projects, repos, branches, issue trackers
3. **Installation** — Install script that symlinks scripts to `~/` or adds to PATH
4. **Documentation** — Comprehensive README with setup guide and examples
5. **Terminal-agnostic** — Replace iTerm2 AppleScript with generic terminal support

## Tips

1. **Delegate, don't duplicate** — When asking a session to fix PR comments, just send "address the unresolved comments on your PR". The session has `gh` access.
2. **Check before spawning** — `~/claude-status` to avoid duplicate sessions.
3. **Detach, don't kill** — `Ctrl-b d` detaches from tmux. Session keeps running.
4. **Peek without attaching** — `tmux capture-pane -t "ao-1" -p -S -30`
5. **Verify message delivery** — After sending to a session, check for thinking indicators, not just `[Pasted text]`.

## Linear Integration

Create tickets via Rube MCP:

```
RUBE_SEARCH_TOOLS: queries=[{use_case: "create an issue in Linear"}]

LINEAR_CREATE_LINEAR_ISSUE:
  team_id: "<AO team ID>"
  title: "Your ticket title"
  description: "Markdown description"
  priority: 2  # 1=Urgent, 2=High, 3=Normal, 4=Low
```
