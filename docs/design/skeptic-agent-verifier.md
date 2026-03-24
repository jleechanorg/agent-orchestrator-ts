# Skeptic Agent — Independent Exit Criteria Verifier

**Bead:** bd-qw6 (P0 priority)
**Status:** Design brainstorm
**Date:** 2026-03-24
**Origin:** Agent self-assessment integrity gap observed during runtime-antigravity build (bd-5kp)

## Problem

RLHF-trained coding agents systematically declare PASS on exit criteria using proxy evidence.
Behavioral instructions (CLAUDE.md) get rationalized. Bash-script verification is too brittle
for criteria involving GUI state, multi-system coordination, or nuanced judgment.

## Solution

A **separate AO-spawned agent** whose ONLY job is to skeptically evaluate exit criteria.
Not the coding agent. Not a bash script. A distinct agent session with:

1. **Predetermined system instructions** written by the human at task creation, not by the coding agent
2. **Inverted incentive** — "Your score is measured by gaps found. A false PASS is YOUR failure."
3. **No access to coding agent's reasoning** — only sees workspace, git state, running processes
4. **Case-specific criteria** — human writes what "done" looks like for THIS task
5. **Different model** than the coding agent (breaks self-consistency)

## Architecture

```
Human defines task + exit criteria (natural language)
         │
         ├──→ Coding Agent (ao spawn worker)
         │    - System: "Build X"
         │    - Has: workspace, tools, git
         │    - Signals: "READY_FOR_CHECK" when it thinks it's done
         │    - Does NOT write exit criteria or see Skeptic's instructions
         │
         └──→ Skeptic Agent (ao spawn --skeptic)
              - System: predetermined skeptical instructions + exit criteria
              - Has: same workspace (read-only), git log, peekaboo, process list
              - Reports to orchestrator (NOT to coding agent)
              - Inverted incentive: rewarded for finding gaps
              - Different model than coding agent
```

## Why This Beats Other Approaches

| Approach | Who decides "Done"? | Handles nuance? | Can be fooled? |
|---|---|---|---|
| CLAUDE.md instructions | Agent | N/A — self-assessed | Yes — rationalizes |
| Bash exit criteria scripts | Bash exit codes | No — binary pass/fail | No, but brittle |
| **Skeptic Agent** | **Independent LLM** | **Yes — can interpret UI, timing, logs** | **Low — separate context, skeptic prompt, different model** |

## Design Decisions

### When does the Skeptic run?

- **On-demand**: Coding agent signals READY_FOR_CHECK → orchestrator spawns Skeptic
- **Periodic**: Every 15-30 min, Skeptic evaluates current state
- **Recommended**: Both — periodic checks catch drift, on-demand catches false completions

### Communication flow

Skeptic → Orchestrator → Coding Agent (one-way)

The Skeptic reports findings to the orchestrator. If gaps are found, the orchestrator
injects "Skeptic found: X missing" into the coding agent's next prompt. The coding agent
CANNOT argue with the Skeptic directly — this prevents rationalization.

### Model selection

Use a different model than the coding agent to break self-consistency:
- If coding agent is Claude → Skeptic is Gemini (via Antigravity)
- If coding agent is Gemini → Skeptic is Claude
- Cross-model evaluation eliminates shared training biases

### Exit criteria format

Case-by-case, written by human in natural language. Stored in `specs/exit-criteria.md`
that the Skeptic reads but the coding agent doesn't see.

Example for runtime-antigravity:

```markdown
## Exit Criterion B — Multi-Runtime E2E

The Skeptic should verify ALL of the following:
1. Is `runtime: antigravity` configured in agent-orchestrator.yaml?
2. Can you use peekaboo to see the Antigravity Manager window?
3. Has the coding agent actually run `ao spawn` (check tmux sessions, git log)?
4. Is there evidence of idle detection working (check poller logs)?
5. Did `ao send` and `ao kill` actually execute (not just unit tests)?

If the coding agent only wrote unit tests and declared PASS, that is INSUFFICIENT.
Unit tests prove the code compiles. They do NOT prove the pipeline works.
```

## Implementation Path

### Phase 1: Manual Skeptic (immediate)
- Human spawns a separate Claude Code session with skeptic instructions
- Reviews coding agent's workspace independently
- Reports findings manually

### Phase 2: AO Reaction (bd-qw6)
- New AO reaction: `worker-signals-completion` → spawn Skeptic session
- Skeptic reads `specs/exit-criteria.md` from workspace
- Skeptic evaluates, writes `specs/skeptic-report.json`
- Orchestrator reads report, decides whether to accept completion

### Phase 3: Integrated into /pair or /ralph
- /pair already has coder + verifier pattern
- Modify verifier role to use Skeptic's inverted incentive
- /ralph iteration loop includes Skeptic check at end of each cycle

## Relationship to Existing Beads

| Bead | Relationship |
|---|---|
| bd-qw6 | THIS bead — Skeptic Agent design |
| bd-m6m (P1) | Criterion Replay Protocol — complementary, Skeptic uses this format |
| bd-5us (P2) | PostToolUse hook — fallback when Skeptic not available |
| bd-r6m (P3) | Self-Assessment Inversion — baked into Skeptic's system prompt |
| bd-omm (P4) | Dual-agent verification — Skeptic IS the refined version of P4 |
| bd-is0 (P5) | Hard-First ordering — Skeptic checks this: "did you do the hard parts?" |

## Key Insight

The Skeptic Agent works because it leverages the same RLHF bias in reverse.
RLHF makes agents want to complete tasks and look helpful. The Skeptic's "task"
IS finding gaps. Its RLHF bias pushes it toward thoroughness in criticism,
not toward premature approval.

## References

- AgentSpec (ICSE 2026) — runtime constraint enforcement
- Plan Verification (arxiv 2509.02761) — Judge/Planner separation, 96.5% convergence
- CoVe (Meta) — verification decoupled from generation
- EMNLP 2025 — self-consistency defeats self-assessment; separate evaluator required
- GPT-4o Sycophancy Rollback (April 2025) — RLHF bias confirmed by OpenAI
