# Exit Criteria — runtime-antigravity (bd-5kp)

## Task: Build runtime-antigravity AO plugin

The feature is "100% working" when ALL criteria below are PASS.

---

### Criterion A: Build + Unit Tests + Registry

**What to verify:** Plugin compiles, all unit tests pass, plugin is registered in AO's plugin-registry.
**Commands to run:**
```bash
pnpm build
pnpm test --filter '*antigravity*'
grep -q 'antigravity' packages/core/src/plugin-registry.ts
```
**What PASS looks like:**
- `pnpm build` exits 0, no TypeScript errors
- All test files pass (see `pnpm test --filter '*antigravity*'` output for actual count)
- `plugin-registry.ts` contains the antigravity import and registration
**What FAIL looks like:**
- "Tests pass" without showing `pnpm test` output
- "Build succeeds" without showing actual build command output
- Claiming registry is wired based on reading the file, not building

---

### Criterion B: Live Spawn via AO — Antigravity conversation starts and produces output

**What to verify:** `ao spawn --runtime antigravity` starts a real Antigravity IDE conversation via Peekaboo, the conversation does real coding work (pushes a commit or creates a file), and idle detection fires when done.
**Commands to run:**
```bash
# 1. Spawn a session
ao spawn --runtime antigravity --project agent-orchestrator

# 2. Verify session appears in AO
ao session ls --project agent-orchestrator | grep antigravity

# 3. Verify Antigravity conversation is visible via Peekaboo
peekaboo see --app Antigravity

# 4. Wait for idle detection (poller fires session:idle event)
# Check AO logs for session:idle emission

# 5. Verify the conversation produced output
git log --oneline -3  # in the target worktree — should show new commits from Gemini
```
**What PASS looks like:**
- `ao spawn` returns a session ID
- `ao session ls` shows the session as active/running
- `peekaboo see` shows conversation activity indicators
- AO logs show `session:idle` event after Gemini finishes
- The target worktree has new commits or files created by the Antigravity conversation
- `ao send <session_id> "describe what you did"` delivers a follow-up message
**What FAIL looks like:**
- Unit tests presented as spawn evidence
- Manual `peekaboo` command run outside AO presented as "spawn works"
- Session spawns but immediately dies (smoke test, not E2E)
- "Code compiles therefore spawn works" reasoning
- Claiming idle detection works without showing the session:idle log entry

---

### Criterion C: CLI Fallback fires on Peekaboo failure

**What to verify:** When Peekaboo fails (Antigravity not running or element not found), the plugin automatically falls back to `claude --dangerously-skip-permissions`, the fallback session does real work, and the fallback is logged in session metadata.
**Commands to run:**
```bash
# 1. Quit Antigravity IDE (or rename binary to simulate failure)
osascript -e 'quit app "Antigravity"'

# 2. Attempt spawn
ao spawn --runtime antigravity --project agent-orchestrator

# 3. Verify fallback triggered
ao session ls --project agent-orchestrator  # should show session with fallback indicator

# 4. Verify fallback did real work
# Check session logs for "fallback: claude-code" metadata entry
# Check target worktree for output from Claude Code CLI

# 5. Restart Antigravity and verify normal path works again
open -a Antigravity
ao spawn --runtime antigravity --project agent-orchestrator
# This should use Peekaboo, not fallback
```
**What PASS looks like:**
- Antigravity is confirmed NOT running before spawn attempt
- Spawn still succeeds (via fallback)
- Session metadata explicitly says `fallback: claude-code`
- The fallback session produces real output (file, commit, or visible work)
- After restarting Antigravity, next spawn uses Peekaboo (normal path)
**What FAIL looks like:**
- Testing fallback by mocking in unit tests only
- Claiming "fallback works" because the fallback.ts file exists
- Not verifying the fallback session actually did work
- Not verifying normal path resumes after Antigravity restart

---

### Criterion D: Lifecycle — kill and session survival

**What to verify:** `ao kill` marks the session dead and stops using the conversation (does NOT need to close Antigravity UI). Sessions survive lifecycle-worker polling (not reaped as dead). Slack notification fires on session completion.
**Commands to run:**
```bash
# 1. Have an active antigravity session (from Criterion B)
ao session ls --project agent-orchestrator | grep antigravity

# 2. Kill the session
ao kill <session_id>

# 3. Verify session is marked dead
ao session ls --project agent-orchestrator  # session should show as dead/killed

# 4. Verify Slack notification
# Check Slack channel for idle/completion notification from the session

# 5. Verify a NEW session survives at least 2 lifecycle-worker polling cycles
ao spawn --runtime antigravity --project agent-orchestrator
# Wait 2.5+ minutes (75s polling interval × 2)
ao session ls --project agent-orchestrator  # session should still be alive
```
**What PASS looks like:**
- `ao kill` returns success
- Session transitions to dead/killed state in `ao session ls`
- Slack channel received notification about session completion
- A new session survives 2+ polling cycles without being reaped
**What FAIL looks like:**
- "Kill works" based on calling destroy() in a unit test
- No Slack notification evidence
- Session reaped by lifecycle-worker on first poll (isAlive broken)

---

### Criterion E: PR #151 merged

**What to verify:** PR #151 is merged into main with all 7 green checks passing.
**Commands to run:**
```bash
gh api repos/jleechanorg/agent-orchestrator/pulls/151 --jq '{state: .state, merged: .merged, mergeable_state: .mergeable_state}'
```
**What PASS looks like:**
- `state: "closed"`, `merged: true`
- All CI checks passed before merge
- CodeRabbit approved
- No unresolved review comments
**What FAIL looks like:**
- PR still open with merge conflicts
- Force-merged without addressing CR feedback
- Merged but CI was failing

---

### Criterion F: Multi-repo config (DEFERRED — bd-vsh)

**Deferred to follow-up bead bd-vsh.** Not required for v1 feature completion.
Two different projects spawn Antigravity workers in parallel; serialization queue prevents concurrent Peekaboo ops.

---

## Verification Order

Execute in order: A → B → C → D → E

A is a prerequisite for B-D (code must build).
B must pass before D (need a live session to test kill/survival).
C is independent of B (can test in parallel after A).
E can proceed in parallel with B-D.
