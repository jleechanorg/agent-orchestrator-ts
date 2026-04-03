# TDD Bead Roadmap: Autonomous Multi-CLI Orchestrator

## Background
This roadmap operationalizes `roadmap/autonomous-orchestrator-multi-cli-design.md` into executable bead work with explicit test-first sequencing.

## Scope
- Build autonomous orchestration without requiring a human chat supervisor
- Support multi-CLI execution with deterministic capability-aware fallback
- Preserve fail-closed safety on merge and action policy enforcement

## Bead Map
- `bd-vsxy` (P0, epic): EPIC: autonomous multi-CLI orchestrator (TDD roadmap)
- `bd-7gdr` (P1): daemon lifecycle + single-writer ownership + lock model
- `bd-jwza` (P1): durable event queue + crash replay semantics
- `bd-d9s3` (P1): multi-CLI scheduler + capability discovery
- `bd-seyf` (P1): safety rails + policy engine + kill-switches
- `bd-why9` (P2): observability, audit trail, and `/doctor` coverage
- `bd-i9gv` (P1): E2E autonomous PR lifecycle proof

## TDD Sequence

### Phase 1 — Runtime ownership and daemon lifecycle
Primary bead: `bd-7gdr`
- Red: failing tests for startup/shutdown idempotence, lock contention, and single-writer guarantees.
- Green: implement daemon lock lifecycle and ownership boundaries.
- Refactor: extract lifecycle guard helpers and harden interfaces.
Exit criteria:
- No duplicate active writers
- Clean recovery after daemon restart

### Phase 2 — Durable queue and replay correctness
Primary bead: `bd-jwza`
- Red: failing tests for dedup keys, retry backoff, DLQ routing, and crash-window replay (`act` vs `verify`).
- Green: implement durable queue with persisted state transitions.
- Refactor: isolate queue storage and replay adapters for deterministic tests.
Exit criteria:
- Idempotent replay after mid-action crash
- At-least-once delivery without duplicate side effects

### Phase 3 — Multi-CLI scheduler and capabilities
Primary bead: `bd-d9s3`
- Red: failing tests for provider scoring, capability mismatch behavior, and deterministic fallback order.
- Green: implement scheduler with capability matrix and degraded-mode contract.
- Refactor: split provider-specific translation and shared action planning.
Exit criteria:
- Unsupported actions fail-closed with explicit reason
- Fallback path deterministic and test-verified

### Phase 4 — Safety and policy enforcement
Primary bead: `bd-seyf`
- Red: failing tests for policy violations, budget exhaustion, and kill-switch interrupt paths.
- Green: implement guardrails (allowlists, budgets, circuit breakers, post-conditions).
- Refactor: centralize policy evaluation and rollback intent model.
Exit criteria:
- Unsafe action paths blocked by default
- Kill-switches stop new execution immediately

### Phase 5 — Observability and operability
Primary bead: `bd-why9`
- Red: failing tests for trace completeness, actor attribution, and `/doctor` diagnostic assertions.
- Green: implement event telemetry, audit records, and health surfaces.
- Refactor: standardize structured logging schema and trace IDs across components.
Exit criteria:
- Every action traceable from trigger to outcome
- `/doctor` reports actionable failure domains

### Phase 6 — End-to-end proof
Primary bead: `bd-i9gv`
- Red: E2E harness that expects full autonomous lifecycle and fails without complete pipeline.
- Green: run full PR lifecycle (create fixture -> claim -> checks -> merge) in sandbox path.
- Refactor: reduce flake via deterministic fixture setup and bounded retries.
Exit criteria:
- True E2E (>60s) passes with outcome artifacts
- Replay safety and fail-closed behavior demonstrated under perturbation

## Recommended Work Order
1. `bd-7gdr`
2. `bd-jwza`
3. `bd-d9s3`
4. `bd-seyf`
5. `bd-why9`
6. `bd-i9gv`

## Open Questions
- Should daemon queue persistence live in existing AO state store or a dedicated store with migration tooling?
- Should capability scoring be static config-first, or adaptive by recent success rates?
- Which commands are permanently blocked vs conditionally allowed by policy profile?
