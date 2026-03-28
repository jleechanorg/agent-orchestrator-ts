# Skeptic Gate — AO Worker Architecture

## Status
- **Current state**: Broken — VERDICT: SKIPPED on all PRs (no LLM backend works in GHA)
- **Fix PR**: https://github.com/jleechanorg/agent-orchestrator/pull/244 (closed, needs reopen)
- **Beads**: bd-1lni (infra broken), bd-0cfv (SKIPPED=success)

## Canonical Design

Skeptic Gate does NOT run LLM evaluation directly in GitHub Actions. It routes through an AO worker on the local machine.

```
┌──────────────────┐     ┌─────────────────────┐     ┌──────────────────┐
│  GHA: skeptic-    │     │  AO Lifecycle Worker │     │  AO Skeptic      │
│  gate.yml         │────>│  (local machine)     │────>│  Worker          │
│  (trigger only)   │     │  detects trigger     │     │  (Codex CLI +    │
│                   │     │                      │     │   OAuth)         │
└──────────────────┘     └─────────────────────┘     └────────┬─────────┘
                                                               │
                                                               v
                                                      ┌──────────────────┐
                                                      │  Posts VERDICT    │
                                                      │  comment to PR   │
                                                      └──────────────────┘
```

### Flow

1. **GHA skeptic-gate.yml** runs on PR events (push, review, etc.)
2. It posts an idempotent trigger comment on the PR (e.g., `<!-- skeptic-trigger -->`)
3. **AO lifecycle-worker** on the local machine detects the trigger via polling
4. Lifecycle-worker spawns a **skeptic AO worker** (`ao spawn --skeptic`)
5. The skeptic worker runs `codex --print` with OAuth auth (no API keys needed)
6. Worker posts the `VERDICT: PASS/FAIL` comment back to the PR
7. GHA action (or a separate check-run update) reads the verdict and updates the CI status

### Why NOT API keys in GHA

| Approach | Problem |
|----------|---------|
| `ANTHROPIC_API_KEY` in GHA secrets | Secret management burden, wrong architecture, bypasses AO |
| `claude --print` in GHA | Binary not available in runners, auth requires API key |
| `codex --print` in GHA | Binary not available in runners |
| Direct Anthropic API curl in GHA | Works but wrong architecture — skeptic should be AO worker |
| **AO worker (correct)** | Uses existing infra, OAuth auth, no secrets, cross-model |

### Existing Infrastructure

These components already exist and were merged in PR #223 (skeptic Phase 2):

- `packages/core/src/skeptic-reviewer.ts` — calls `ao skeptic verify`
- `packages/core/src/fork-skeptic-extension.ts` — implements skeptic-review reaction
- `worker-signals-completion` reaction — triggers on `pr_open` transition
- `llm-eval.ts` — centralized LLM evaluation with Codex primary, Claude fallback

### What PR #244 Does

1. Replaces direct CLI+API-key invocation in `skeptic-gate.yml` with trigger comment
2. Adds `skeptic-trigger` reaction to lifecycle-worker config
3. AO worker picks up the trigger and runs evaluation locally
4. Worker posts verdict comment; GHA action reads it and updates check status

### Auth Model

- **Codex CLI**: Uses OAuth by default (no API key needed)
- **Claude CLI fallback**: Uses `~/.claude/config` (OAuth, no API key)
- Both are available on the local machine where AO runs
- Neither requires repo secrets in GitHub

## SKIPPED = FAIL (fail-closed)

Until PR #244 is merged and working, the interim fix is:
- `VERDICT: SKIPPED` must exit 1 (FAIL), not exit 0 (success)
- This prevents false-positive gate passage
- bd-0cfv tracks this interim fix

## Related Beads

| Bead | Title | Priority |
|------|-------|----------|
| bd-1lni | Skeptic Gate infrastructure broken | P0 |
| bd-0cfv | SKIPPED = success (should be fail-closed) | P0 |
| bd-kvvx | Skeptic false-positive on PRs missing CR APPROVED | P0 |
| bd-io8q | Zero branch protection on main | P0 |
