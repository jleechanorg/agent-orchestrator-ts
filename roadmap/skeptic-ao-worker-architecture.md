# Skeptic Gate — AO Worker Architecture

## Status
- **Current state**: Broken — VERDICT: SKIPPED on all PRs (no LLM backend works in GHA)
- **Fix PR**: https://github.com/jleechanorg/agent-orchestrator-ts/pull/244 (closed, needs reopen)
- **Beads**: bd-1lni (infra broken), bd-0cfv (SKIPPED=success)

**Document map**: The sections above and below this note preserve the historical AO repo
skeptic-worker design and PR #244 context. The normative contract for current
merge-gate verdict binding is [2026-04-19 Fresh Verdict Contract](#2026-04-19-fresh-verdict-contract).

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

## 2026-04-19 Fresh Verdict Contract

This supersedes the old "Gate 7 = skeptic only" rollup language. Existing
workflow labels may still say "7-green" until renamed, but a merge-grade skeptic
PASS now requires eight blocking markers. Gate 8 is enforced inside the skeptic
verdict artifact rather than as a separate CI workflow.

### Trigger Schema

GitHub Actions must post one request-bound trigger per head SHA:

```markdown
SKEPTIC_GATE_TRIGGER
<!-- skeptic-request-id-gate-24633364977-1-6370-fb08ff7b03b3 -->
<!-- skeptic-head-sha-fb08ff7b03b35ccb5a779b98a532e1923a821b39 -->
<!-- skeptic-gate-trigger-fb08ff7b03b35ccb5a779b98a532e1923a821b39 -->
```

The `request_id` must be unique per workflow run attempt and PR/head SHA pair.
The head SHA marker must contain the full 40-character commit SHA.

### Verdict Comment Schema

The merge gate may only parse a PASS from a single machine-readable PR comment
artifact. The comment must include all of:

```markdown
<!-- skeptic-agent-verdict -->
<!-- skeptic-request-id-gate-24633364977-1-6370-fb08ff7b03b3 -->
<!-- skeptic-head-sha-fb08ff7b03b35ccb5a779b98a532e1923a821b39 -->
<!-- skeptic-gate-1:PASS -->
<!-- skeptic-gate-2:PASS -->
<!-- skeptic-gate-3:PASS -->
<!-- skeptic-gate-4:PASS -->
<!-- skeptic-gate-5:PASS -->
<!-- skeptic-gate-6:PASS -->
<!-- skeptic-gate-7:PASS -->
<!-- skeptic-gate-8:PASS -->
VERDICT: PASS
<!-- skeptic-gate-trigger-fb08ff7b03b35ccb5a779b98a532e1923a821b39 -->
```

`VERDICT: FAIL` and `VERDICT: SKIPPED` may be parsed without all PASS gate
markers so the system fails closed. `VERDICT: SKIPPED` is blocking.

### Trusted Actor Rule

Verdicts from the PR author or arbitrary human users are forbidden. The preferred
actor is a GitHub App or fixed service account whose token is held only by the
worker. Any allowlist must bind to a stable automation login or user id, not a
display name or the PR author's personal account.

### Eight Gates

| Gate | Blocking question |
|------|-------------------|
| 1 | CI is complete and passing for the exact head SHA. |
| 2 | Required reviews are present and current for the exact head SHA. |
| 3 | CodeRabbit or equivalent review is approved, or explicitly not applicable. |
| 4 | Bugbot is clean by check-run status and unresolved blocking inline findings. |
| 5 | Mergeability is clean: no conflicts, stale head, or branch policy blocker. |
| 6 | Evidence exists and is complete for the claim class, including explicit N/A where appropriate. |
| 7 | Skeptic has independently reviewed the technical behavior, risks, tests, and gate results. |
| 8 | The PR description goals, tenets, and stated scope align with the actual diff and evidence. |

Gate 7 is an independent technical risk review of this change. Gate 8 is product
and document alignment: description, scope, tenets, code, and evidence must prove
the same work. They can run in the same LLM pass, but the prompt and output must
contain distinct subsections and separate gate markers.

### Implementation Order

1. Define the trigger and verdict schemas with example comments.
2. Add parser tests that reject legacy SHA-only PASS comments.
3. Update GitHub Actions polling to require marker, request id, head SHA, fresh
   timestamp, trusted actor, and eight PASS gate markers.
4. Update skeptic prompts so PASS is invalid unless all eight gate markers are
   emitted after detailed review.
5. Update reviewer-facing docs and `/er` references that still describe the old
   seven-gate policy.

## Related Beads

| Bead | Title | Priority |
|------|-------|----------|
| bd-1lni | Skeptic Gate infrastructure broken | P0 |
| bd-0cfv | SKIPPED = success (should be fail-closed) | P0 |
| bd-kvvx | Skeptic false-positive on PRs missing CR APPROVED | P0 |
| bd-io8q | Zero branch protection on main | P0 |
