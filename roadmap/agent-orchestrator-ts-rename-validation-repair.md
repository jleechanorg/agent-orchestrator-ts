# Agent Orchestrator TypeScript Rename Validation Repair

## Context

The repository rename from `jleechanorg/agent-orchestrator` to
`jleechanorg/agent-orchestrator-ts` is primarily a reference migration. The
first CI run also exposed validation failures already present at the PR base:

- `setup-launchd.sh` no longer retained the legacy canonical clone fallback.
- two source-structure tests used lint-invalid regular expressions, and one
  used `node:test` inside the Vitest suite so Vitest reported no suite.
- orchestrator workspace assertions still described behavior from before the
  workspace-plugin integration.
- archive restore liveness enrichment recreated active metadata before the
  archived session passed restorability validation.

Leaving these failures in place made the rename PR unmergeable. The repair is
kept in this PR because the rename changes the canonical launchd path and the
base validation failures prevent the reference migration from reaching a
reviewable exact head.

## Design

1. Prefer `$HOME/project_agento/agent-orchestrator-ts` for launchd jobs created
   from ephemeral `ao-N` worktrees, while retaining
   `$HOME/project_agento/agent-orchestrator` as a compatibility fallback.
2. Run source-structure tests under the repository's Vitest runner and resolve
   source paths relative to the test module, independent of the current working
   directory.
3. Align orchestrator workspace expectations with the existing production
   implementation: the workspace plugin creates the isolated workspace and the
   runtime receives that managed path.
4. Keep archive metadata read-only during pre-validation liveness enrichment.
   Active metadata may be updated only after an archived session is accepted as
   restorable.

No service labels, schedules, loaded launchd jobs, or installed binaries change
as part of this PR.

## Evidence

- RED: [initial CI test and lint failures](https://github.com/jleechanorg/agent-orchestrator-ts/actions/runs/29134699337)
- RED: [initial diff-coverage failure](https://github.com/jleechanorg/agent-orchestrator-ts/actions/runs/29134699345)
- GREEN: [exact-head test, lint, typecheck, and web run](https://github.com/jleechanorg/agent-orchestrator-ts/actions/runs/29137887018)
- GREEN: [exact-head diff coverage](https://github.com/jleechanorg/agent-orchestrator-ts/actions/runs/29137886982)
- GREEN: [exact-head evidence gate](https://github.com/jleechanorg/agent-orchestrator-ts/actions/runs/29137898598)

## Rollback

Revert the validation-repair commit. Existing services remain unaffected
because this PR does not install or reload launchd jobs.
