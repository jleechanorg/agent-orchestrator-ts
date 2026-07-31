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
| Gate 1 | Latest terminal non-advisory check runs at the live PR head | Bind the verdict to reviewed code and fail closed |
| Gate 2 | REST mergeability with bounded retry for `null` | Use live GitHub state and fail closed |
| Reviewer/evidence state | Remove from `/green` exit logic | These are advisory or draft-phase concerns |
| Runner | `[self-hosted]` | Enforce the private-repository runner policy without a mutable hosted-runner override |

## Failure Handling

Missing identity, API errors, no checks, pending/failed/cancelled checks, moved head,
or unresolved/non-mergeable state all fail. The result comment includes the exact head
SHA. Advisory review bots and evidence formatting do not affect the exit code.

## Test Strategy

The contract test reads the workflow because the behavior is encoded in its shell body.
RED is the same test against `origin/main`, where all six assertions fail. GREEN requires
all six assertions, YAML parsing, actionlint, and `git diff --check` to pass. The draft PR
then supplies Layer 2 GitHub Actions evidence.

## Rollback

Revert the implementation commit. Do not restore retired gates individually; any future
policy change must update this design and the contract test together.
