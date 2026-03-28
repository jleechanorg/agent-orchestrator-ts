# babysit-openclaw

Monitor an openclaw task in a Slack thread, detect fabrication and stalls, and nudge via Slack when needed.

## Usage

```text
/babysit-openclaw <thread_ts> [channel_id]
```

Default channel: `C0AKYEY48GM`

## Step 1 — Read the thread

```python
# Use mcp__slack__conversations_replies
# channel_id: C0AKYEY48GM (or provided)
# thread_ts: <from argument>
```

## Step 2 — Assess status

Check the **last message from openclaw** and apply these signals:

### Fabrication signals (nudge immediately)
- `completion_ts - instruction_ts < 60s` for any multi-step I/O task (clone, install, startup)
- "Proof" section lists command names without actual terminal output
- Clean bullet points describing steps instead of messy terminal output
- Generic success language ("dependency install completed", "startup logs reached ready state")

### Stall signals (nudge if > 10 min since last openclaw message)
- openclaw said "on it" / "executing now" / "I'll complete" but no follow-up
- openclaw admitted stopping ("I stopped again") and promised to execute — no follow-up
- No new message from openclaw in 10+ minutes after an instruction

### OK signals (do not nudge)
- openclaw posted real terminal output (messy, with package names, versions, paths)
- openclaw explicitly said "not run yet" / held back a step rather than fabricating
- openclaw is actively posting partial progress with evidence
- Task is complete with real proof

## Step 3 — Nudge if needed

Post via the cmux bot token from openclaw.json (NOT mcp__slack — posts as openclaw bot = self-loop):

```python
import json, urllib.request

msg = "[AI Terminal: <workspace>] <@U0AEZC7RX1Q> <nudge text>"

payload = json.dumps({
    "channel": "C0AKYEY48GM",
    "thread_ts": "<thread_ts>",
    "text": msg
})
req = urllib.request.Request(
    "https://slack.com/api/chat.postMessage",
    data=payload.encode(),
    headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
)
with urllib.request.urlopen(req) as resp:
    d = json.loads(resp.read())
    print(f"OK ts={d.get('ts')}" if d.get("ok") else f"ERROR: {d.get('error')}")
```

Token source: `~/.openclaw/openclaw.json → channels.slack.cmuxBotToken` (cmux bot, app A0AHF4EBZPE).

### Nudge message guidelines

- Reference the specific timestamp/quote of the last commitment openclaw made
- State the drop count if > 2 ("That's 4 drops on the same task")
- List the exact outstanding deliverables (e.g., "startup logs", "MiniMax config check", "test-call result")
- End with: "Do not acknowledge this message — just execute and post the transcript."
- Prefix: `[AI Terminal: <workspace>]`

## Step 4 — Report

After each check, report:
- Last openclaw message timestamp and content (1-line summary)
- Assessment: OK / FABRICATED / STALLED
- Action taken: nudged (ts=...) / no action needed
- Drop count if tracking

## Fabrication detection reference

| Signal | Example |
|--------|---------|
| Too fast | 25s between "do it" and "Done" for clone+install+startup |
| No machine-specific output | Missing paths like `/Users/jleechan/...`, package counts, timing |
| Clean proof section | Bullet list of command names only |
| Generic language | "dependency install completed", "reached ready state" |

Real terminal output looks like:
```text
added 262 packages, and audited 263 packages in 5s
Successfully installed MarkupSafe-3.0.3 PyJWT-2.12.1 ...
/Users/jleechan/.openclaw/workspace/hermes-agent
```

## Key constants

- openclaw bot user ID: `U0AEZC7RX1Q`
- default channel: `C0AKYEY48GM`
- token source: `~/.openclaw/openclaw.json → channels.slack.cmuxBotToken` (cmux bot, app A0AHF4EBZPE, user U0AH532BK2P)
- AI identity prefix: `[AI Terminal: <workspace-name>]` (required by CLAUDE.md)

## Why mcp__slack doesn't work for nudging

`mcp__slack__conversations_add_message` posts as the openclaw bot (`$OPENCLAW_BOT_USER_ID`). openclaw's self-loop prevention ignores messages from its own account. The OpenClaw gateway (`http://127.0.0.1:18789`) may be webchat-bound with no Slack session target. The cmux bot token posts as a different bot (U0AH532BK2P), which triggers openclaw.
