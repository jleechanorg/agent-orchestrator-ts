# Skeptic Chain Integration Test — Design

## Context

In the last 24h, 10 PRs (46% of all work) were skeptic infrastructure fixes. Each fix exposed the next bug because there was no integration test validating the full skeptic chain. This churn wastes massive developer time.

## Goals

Validate the end-to-end skeptic chain: trigger comment → lifecycle-worker detection → `ao skeptic verify` → VERDICT comment → GHA polling step finds it. Catch regressions in comment format, marker alignment, and jq filter matching before they reach CI.

## Design

### File location
`packages/core/src/__tests__/skeptic-chain-integration.test.ts`

### Scope (what is tested)

1. **Happy path PASS**: `runSkepticReview` with PASS verdict → verdict comment posted with correct HTML markers, author field, SHA marker, and timestamp
2. **FAIL verdict**: same chain, VERDICT: FAIL in body — catches silent throw/catch regressions
3. **SKIPPED verdict**: same chain, VERDICT: SKIPPED in body — SKIPPED is non-blocking but must still post
4. **JQ filter match**: Construct a gh comments API response matching skeptic-gate.yml criteria; verify the jq expression finds the correct comment

### Scope (what is NOT tested — covered by existing unit tests)

- CLI verdict regex parsing → `skeptic.test.ts`
- PASS→success / FAIL→failure mapping → `fork-skeptic-extension.test.ts`
- `runSkepticReview` calls `ao skeptic verify` with correct args → `skeptic-reviewer.test.ts`

### Architecture

```
skeptic-chain-integration.test.ts

vi.mock("node:child_process")    ← gh exec calls
vi.mock("./gh-client")           ← REST comment post/patch
vi.mock("../fork-skeptic-extension") ← runSkepticReviewReaction
vi.mock("./tmux")                ← no real tmux

import { runSkepticReview } from "../skeptic-reviewer"

Tests 1-3: call runSkepticReview(session, {postComment: true})
  → verify gh-client createComment called once
  → comment body contains:
      <!-- skeptic-agent-verdict -->
      VERDICT: <PASS|FAIL|SKIPPED>
      _Posted by <botAuthor> · <ISO timestamp>
      <!-- skeptic-gate-trigger-<sha> -->

Test 4: JQ filter match
  → build mock gh comments API response matching skeptic-gate.yml filter:
      user.login ∈ {SKEPTIC_BOT_AUTHOR, github-actions[bot]}
      body contains "VERDICT:"
      updated_at >= TRIGGER_UPDATED
      body contains "skeptic-gate-trigger-<TRIGGER_SHA>"
  → run jq filter against response
  → assert matching comment is the expected verdict
```

### Mock strategy

Mirrors `skeptic-reviewer.test.ts`: `vi.hoisted` + `vi.mock("node:child_process")` with `Symbol.for("nodejs.util.promisify.custom")` so `execFileAsync` returns the mock. gh-client functions mocked directly.

### Verdict body format (from `posting.ts`)

```
<!-- skeptic-agent-verdict -->
**🤖 Skeptic Agent Verdict (bd-qw6)**

VERDICT: PASS

_Posted by <botAuthor> · <ISO timestamp>_
<!-- skeptic-gate-trigger-<sha> -->
```

### JQ filter (from skeptic-gate.yml line 235)

```
[.[] |
 select(
   ((.user.login == env.SKEPTIC_BOT_AUTHOR) or (.user.login == "github-actions[bot]"))
   and (.body | test("VERDICT:"; "i"))
   and (.updated_at >= env.TRIGGER_UPDATED)
   and (.body | test("skeptic-gate-trigger-" + env.TRIGGER_SHA; "i"))
 )] | .[-1] // empty
```

### Session fixture

`makeSession({ pr: makePR(), workspacePath: tmpDir })` — workspacePath required when `postComment: true` (writes `specs/skeptic-report.json`). Backfill sessions (workspacePath: null) tested separately in unit tests.
