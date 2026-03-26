# Peekaboo `see` Bug — Antigravity A11y Tree Hang

## Summary

`peekaboo see --app Antigravity --window-id <ID> --json` hangs indefinitely
with a Swift continuation leak error. This blocks reading Antigravity conversation
content programmatically.

## Environment

- **peekaboo**: v3.0.0-beta3 (main/69376fa4-dirty, built 2025-12-29)
- **macOS**: Darwin 24.5.0
- **Antigravity**: com.google.antigravity (Electron/VS Code fork)

## Symptoms

1. `peekaboo see --app Antigravity --window-id <any>` never returns
2. Error in stderr: `SWIFT TASK CONTINUATION MISUSE: _createCheckedThrowingContinuation(_:) leaked its continuation without resuming it`
3. `peekaboo image --app Antigravity --window-id <ID> --path /tmp/x.png` also hangs with same error

## What WORKS

| Command | Status |
|---------|--------|
| `peekaboo list windows --app Antigravity --json` | OK |
| `peekaboo paste --app Antigravity --text "..."` | OK |
| `peekaboo press Return --app Antigravity` | OK |
| `peekaboo see --app Terminal --json` | OK (0 elements) |

## What FAILS

| Command | Status |
|---------|--------|
| `peekaboo see --app Antigravity --window-id 16187` | HANG |
| `peekaboo see --app Antigravity --window-id 16819` | HANG |
| `peekaboo image --app Antigravity --window-id 16187 --path /tmp/x.png` | HANG |

## Root Cause (confirmed via diagnostics)

**NOT Antigravity-specific** — peekaboo `see` also hangs on Finder and other apps.
The bug affects the entire **capture subsystem** (`see` and `image` commands).

Root cause: incomplete async-await refactoring in peekaboo 3.0.0-beta3's
vision/capture pipeline. A Swift `_createCheckedThrowingContinuation` is created
but never `resume()`d, leaving the task suspended indefinitely.

**Process accumulation**: Each failed attempt spawns a hung peekaboo process
(7-8% CPU, R/S state). Found 18+ zombie-like processes after this session.
Kill with: `pkill -9 -f "peekaboo see"; pkill -9 -f "peekaboo image"`

## Workarounds

1. **Use paste/press without see**: Can send prompts to Antigravity without
   reading the A11y tree. Requires knowing the window is focused.
2. **Check output via git**: Instead of reading conversation content, check
   `git log` and `git diff` in the target workspace to verify Gemini produced work.
3. **Use `agy` CLI**: Can open workspaces without needing `see`.

## Impact on runtime-antigravity

The runtime plugin's `see()`, `click()`, and snapshot operations will fail
when running against real Antigravity. The CLI fallback path becomes critical.
The `executeWithFallback` pattern in fallback.ts handles this — when peekaboo
times out, it falls back to `claude --dangerously-skip-permissions`.

## Resolution

Need peekaboo update to fix the Swift continuation handling for large A11y trees.
Track as a peekaboo upstream issue.
