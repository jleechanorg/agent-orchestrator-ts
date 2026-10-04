# Two-Gate Green Gate Design

Bead: `bd-replace-six-gate-green-qdsv`

## Exit Criteria

1. `python3 -m pytest tests/test_green_gate_policy.py -q` proves the workflow emits exactly two result rows: current-head CI and live mergeability.
2. The contract test proves CodeRabbit, Bugbot, review threads, and evidence formatting cannot change the Green Gate exit code.
3. The workflow is valid YAML and uses the immutable `[self-hosted]` selector.
4. A draft-PR run at the implementation SHA reports Gate 1 and Gate 2 only.
5. No merge is performed.

## Problem

The active workflow still implements six gates and runs on `ubuntu-latest`. Exact-head
run [30612255378](https://github.com/jleechanorg/agent-orchestrator-ts/actions/runs/30612255378/job/91097445884)
showed CI and mergeability passing while the job failed solely because retired Gate 3
found no CodeRabbit approval.

## Decisions

| Decision | Choice | Reason |
|---|---|---|
| Workflow owner | Replace the existing workflow in place | Preserve the branch-protection check identity |
| Gate 1 | Latest terminal non-advisory `statusCheckRollup` contexts at the expected PR head | Evaluate both `CheckRun.conclusion` and legacy `StatusContext.state`, and fail closed |
| Gate 2 | REST mergeability with bounded retry for `null` | Use live GitHub state and fail closed |
| Reviewer/evidence state | Remove from `/green` exit logic | These are advisory or draft-phase concerns |
| Runner | `[self-hosted]` | Enforce the private-repository runner policy without a mutable hosted-runner override |

## Failure Handling

Missing identity, API errors, no contexts, pending/failed/cancelled check runs,
pending/failed legacy statuses, a moved head, or unresolved/non-mergeable state all
fail. A mismatch between the event/dispatch SHA and the live PR head exits before
polling or commenting, so one run never silently certifies a different commit. The
result comment includes the exact head SHA. Advisory review bots and evidence
formatting do not affect the exit code.

## Test Strategy

The contract test reads and executes the workflow's shell body because that is where
the behavior is encoded. RED covers the prior REST-only check-run implementation and
its warn-and-continue moved-head branch. GREEN requires structural assertions plus
deterministic boundary replays for success, API outage, zero contexts, CheckRun
pending/failure/cancellation, legacy status pending/failure/success, and a moved head.
YAML parsing, actionlint, and `git diff --check` must also pass. The draft PR then
supplies Layer 2 GitHub Actions evidence.

## Rollback

Revert the implementation commit. Do not restore retired gates individually; any future
policy change must update this design and the contract test together.
