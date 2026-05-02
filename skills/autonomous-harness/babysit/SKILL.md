---
name: babysit
description: Monitor, steer, and recover AO workers. Track lifecycle events, detect stuck/stale workers, send steering signals to redirect.
---

# AO Worker Babysit Skill

## Overview

Monitor and manage AO worker lifecycle. Detects stuck/stale workers, sends steering signals, handles crash recovery. **Prompt-driven** — uses system prompts to steer, not code.

## Usage

```
/babysit <worker-id> [--watch] [--steer <instruction>]
```

## Execution

### Step 1: Check Worker Status
Query AO for worker state:
```bash
ao list --worker <worker-id> --json
```

Check for:
- `status: running` vs `status: stuck` vs `status: dead`
- `last_heartbeat` — stale if >5 min ago
- `current_task` — is it making progress?
- `error_count` — consecutive failures

### Step 2: Detect Stuck State

A worker is stuck if:
- No progress for >10 min (no new commits, no artifact updates)
- Heartbeat stale >5 min
- Same error repeating >3 times
- Response time >2x expected for task type

### Step 3: Steering Protocol

If stuck, send a steering signal via DM (not the worktree — DM only):

```
[Worker <worker-id>] appears stuck on "<current_task>".
Last progress: <timestamp>.
Steering instruction: <instruction>

Steps to attempt:
1. Write current state to artifact
2. Reset context (clear conversation history, reload artifacts)
3. Resume with: "<redirect_instruction>"
4. If still stuck after 5 min, terminate and escalate.
```

**Important**: Always preserve state before redirecting. The next agent must be able to resume from the artifact.

### Step 4: Crash Recovery

If worker dies:
1. Check if work was committed: `git log --since="10 minutes ago"`
2. If committed: log as "completed with crash"
3. If not committed: check workspace for uncommitted changes
4. Respawn with same brief but resume from last artifact

## Steering Signal Format

Send to worker via DM (not worktree):
```json
{
  "type": "steer",
  "worker_id": "<id>",
  "signal": "context_reset",
  "reason": "<why>",
  "redirect": "<what to do next>",
  "preserve_state": ["artifact1.md", "harness_state.json"]
}
```

## Escalation Triggers

Escalate to human if:
- Worker crashes >3 times on same task
- Worker produces obviously wrong architecture (not just bugs)
- Cost estimate exceeds budget by >50%
- Context reaches 95% with no progress

Escalation message format:
```
ESCALATION: Worker <id> on task <brief>
- Status: <state>
- Crashes: <count>
- Last progress: <timestamp>
- Issue: <specific problem>
- Human action required: <what to do>
```