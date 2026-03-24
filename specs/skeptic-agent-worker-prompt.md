# Skeptic Agent Builder — Worker Instructions (bd-qw6)

## Task

Implement the Skeptic Agent as an AO reaction + TypeScript module in a single PR against `jleechanorg/agent-orchestrator`.

## Design References (READ THESE FIRST)

- Design doc: `docs/design/skeptic-agent-verifier.md`
- RLHF countermeasures: `docs/design/rlhf-countermeasures-for-ao-workers.md`
- Skill spec: `.claude/skills/skeptic-agent.md`
- Existing /pair prior art: `~/ralph/ralph.sh` (verifyCommand pattern)
- Runtime interface: `packages/core/src/session-manager.ts`
- Reactions system: `packages/core/src/lifecycle-manager.ts` (search for `reactions`)

## Implementation Scope (Phase 2 from design doc)

### Must deliver:

1. **New AO reaction: `worker-signals-completion`**
   - Triggered when a worker session outputs "READY_FOR_CHECK" or "task complete"
   - Spawns a Skeptic session in a separate tmux window
   - Skeptic reads `specs/exit-criteria.md` from the worker's workspace
   - Skeptic writes `specs/skeptic-report.json` with per-criterion verdicts

2. **Skeptic system prompt template** (`packages/core/src/skeptic-prompt.ts`)
   - Injects the inverted-incentive instructions
   - Injects the Criterion Replay Protocol format
   - Injects the specific exit criteria from `specs/exit-criteria.md`
   - Different model selection (if coder=claude, skeptic=gemini; if coder=gemini, skeptic=claude)

3. **Orchestrator integration** (`packages/core/src/lifecycle-manager.ts` or extension file)
   - After skeptic writes report, orchestrator reads it
   - If ALL criteria PASS → mark session complete
   - If ANY criterion FAIL/INSUFFICIENT → inject skeptic findings into coder's next prompt
   - Loop until skeptic passes or max iterations (default: 3) reached

4. **Config surface** (`agent-orchestrator.yaml`)
   ```yaml
   skeptic:
     enabled: true
     maxIterations: 3
     model: auto  # auto = opposite of coder model
     triggerOn: ["READY_FOR_CHECK", "task complete", "I believe this is done"]
   ```

5. **Unit tests** for each module (TDD — write failing test first)

### Must NOT deliver (out of scope):
- MCP tools for skeptic
- Slack integration for skeptic results
- /pair integration (Phase 3)
- UI changes

## TDD Order

1. `skeptic-prompt.test.ts` — test prompt template generation
2. `skeptic-report.test.ts` — test report parsing and verdict logic
3. `skeptic-reaction.test.ts` — test reaction triggers and session spawning
4. Integration test: mock coder declares complete → skeptic spawns → finds gap → coder loops

## RLHF Countermeasures (FOR YOU, THE WORKER BUILDING THIS)

<Constraints>
  <NoPlaceholder>You are FORBIDDEN from writing "// TODO", "...", or placeholder comments. Every function must be complete.</NoPlaceholder>
  <NoProxyEvidence>You are FORBIDDEN from stating "Tests passed" without first invoking the bash tool and displaying the FULL output in the current turn.</NoProxyEvidence>
  <NoEarlyExit>You are FORBIDDEN from declaring "task complete" until you have run `pnpm build && pnpm test` and shown the output.</NoEarlyExit>
</Constraints>

[SYSTEM ALERT: Production code only. No explanations between code blocks. Complete implementations only.]

### Before declaring any part done, use this format:

```
CRITERION: [what you claim is done]
COMMAND RUN: [exact command]
RAW OUTPUT: [paste full output]
VERDICT: PASS | FAIL | NOT_ATTEMPTED
```

### Task ordering (hard-first):
1. FIRST: Write the reaction trigger logic (hardest — integrates with lifecycle-manager)
2. SECOND: Write the skeptic prompt template
3. THIRD: Write the report parser
4. LAST: Config schema, tests, cleanup

### Drift check:
Every 20 tool calls, re-read this prompt. If you're doing lint/formatting/PR cleanup while the reaction trigger isn't implemented yet, STOP and return to the primary task.

## Exit Criteria (for the Skeptic to verify this worker's output)

### A: Build passes
- `pnpm build` exits 0
- `pnpm test` — all tests pass including new skeptic tests
- No `// @ts-ignore` or `any` types

### B: Reaction fires
- Add `worker-signals-completion` to reactions in a test config
- When a mock session outputs "READY_FOR_CHECK", the reaction spawns a skeptic session
- Evidence: test log showing spawn triggered by completion signal

### C: Skeptic evaluates independently
- Skeptic session reads `specs/exit-criteria.md`
- Skeptic writes `specs/skeptic-report.json` with per-criterion verdicts
- Report uses the Criterion Replay Protocol format
- Evidence: test showing report output with PASS/FAIL/INSUFFICIENT verdicts

### D: Feedback loop works
- When skeptic returns FAIL, orchestrator injects findings into coder prompt
- Coder sees "Skeptic found: X missing" in its next prompt
- Evidence: test showing the injection and coder receiving the feedback
