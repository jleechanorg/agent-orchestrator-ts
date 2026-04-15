# Governance Layer Design

## Status

- **Type**: Feature design
- **Author**: Hermes Agent
- **Created**: 2026-04-15

## Motivation

The agent-orchestrator fork currently merges PRs based on CI green + CodeRabbit approval. This is insufficient for safe autonomous merging because:

1. **Evidence quality is unverified** — PRs may claim tests passed without reproducible artifacts
2. **No semantic review** — CodeRabbit checks style/naming, not correctness or security implications
3. **Merge gates are fragile** — single-point failures (e.g., the historical SKIPPED=success bug in skeptic gate, now fixed via `skepticPassed = verdict === "PASS"` in `packages/core/src/merge-gate.ts` per bd-0cfv)
4. **No escalation path** — stuck/broken agents have no human override mechanism
5. **Zero-touch is aspirational** — current zero-touch metrics (`max_inactivity_gap <= 60 min`) are not enforced

A governance layer is needed to enforce semantic quality gates before autonomous merge.

## Goals

- **Fail-closed**: Any governance check failure blocks merge, never silently passes
- **Observable**: Every governance decision is logged with reasoning
- **Configurable**: Per-project or global governance policies via `agent-orchestrator.yaml`
- **Non-blocking for agents**: Governance runs asynchronously from agent work
- **Audit trail**: Governance verdicts are committed as PR comments or check-run annotations

## Non-Goals

- This is NOT a code review replacement — human reviewers are still required for risky changes
- This is NOT a security scanner — semantic security analysis requires separate tooling
- This does NOT replace the skeptic gate — they operate in sequence

## Architecture

```text
┌─────────────────────────────────────────────────────────────────┐
│                     Governance Layer                            │
├──────────────┬──────────────┬──────────────┬──────────────────┤
│ Evidence      │ Merge Gate   │ Escalation   │ Policy           │
│ Validator     │ Enforcer     │ Manager      │ Engine           │
└───────┬───────┴───────┬──────┴───────┬──────┴────────┬─────────┘
        │               │              │                │
        v               v              v                v
┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│ CI artifacts │ │ PR state     │ │ Stuck agent  │ │ YAML policy  │
│ + claim class│ │ (green, CR   │ │ detection    │ │ (per-project)│
│              │ │  approved)   │ │ + handoff    │ │              │
└──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘
```

### Component Definitions

#### 1. Evidence Validator

Verifies that PR evidence bundles meet quality standards before merge.

**Checks:**
- `artifacts/` directory present and non-empty
- Test logs attached (not just "tests passed" claim)
- Claim class declared (`bugfix`, `feature`, `chore`, `refactor`, etc.)
- Evidence reproducibility (can steps be followed by a human reviewer?)
- **Claim-class validation**: cross-checks declared claim class against changed file paths (e.g., `docs/**` for `docs` claims, `src/**` for `feature`/`bugfix`). See `evidence-gate.yml` claim-class floor rule (Fix 2) which enforces minimum claim class based on changed files. This prevents mislabeling code changes as `chore`/`docs` to bypass review.

**Output:** `EVIDENCE_VALID: PASS|FAIL` comment on PR

#### 2. Merge Gate Enforcer

Replaces naive "CI green + CR approved" with multi-gate evaluation.

**Gates (all must pass):**
1. CI status = success
2. CodeRabbit review = APPROVED (or `chore`/`docs` claim class exempts this, subject to claim-class validation — see Evidence Validator below)
3. Skeptic verdict = PASS (or `SKIPPED` treated as FAIL, per bd-0cfv)
4. Evidence validation = PASS
5. Policy checks = PASS

**Output:** `MERGE_GATE: UNLOCKED|BLOCKED` comment on PR

#### 3. Escalation Manager

Detects stuck/broken agents and routes to human intervention.

**Triggers:**
- Agent inactivity > `escalation_threshold` minutes (default: 30)
- Same CI failure repeated > `escalation_retry_limit` times (default: 3)
- Human comment requesting escalation (e.g., `/escalate`)

**Actions:**
- Posts `ESCALATION: human_review_required` comment
- Updates PR label to `escalated`
- Notifies via configured notifier (Slack/OpenClaw)

**Output:** `ESCALATION: triggered|cleared` with reason

#### 4. Policy Engine

Evaluates per-project governance rules from `agent-orchestrator.yaml`.

**Policy schema:**
```yaml
governance:
  enabled: true
  failClosed: true           # default: true
  evidenceRequired: true     # require evidence bundle
  requiredReviewers: []      # list of required GitHub usernames
  blockingLabels: []         # labels that block merge
  requiredLabels: []         # labels that must be present
  maxInactivityMinutes: 60   # zero-touch smooth rule
  escalationThresholdMinutes: 30

projects:
  my-app:
    governance:
      requiredLabels: [owned-by-ai]
      blockingLabels: [security-change, breaking-change]
      requiredReviewers: [jleechan]
```

## Implementation Plan

### Phase 1: Merge Gate Enforcer (this PR)
- New plugin: `packages/plugins/gate-governance/`
- Extends existing `packages/core/src/lifecycle-manager.ts`
- Adds `governanceGate` reaction
- No new dependencies

### Phase 2: Evidence Validator
- Extends existing evidence-bundle infrastructure
- Adds `evidence-validate` CLI command
- Integrates with existing `docs/evidence/reviewer-checklist.md`

### Phase 3: Escalation Manager
- Extends existing `worker-signals-completion` reaction
- Adds `escalation` reaction
- Integrates with OpenClaw notifier

### Phase 4: Policy Engine
- Adds YAML policy evaluation to governance plugin
- Backwards-compatible with existing `reactions` config

## Integration Points

| Component | Integration | File |
|-----------|-------------|------|
| Merge gate | `lifecycleManager.on("prTransition")` | `packages/core/src/lifecycle-manager.ts` |
| Evidence validator | `ao evidence validate` CLI | `packages/core/src/cli/evidence.ts` |
| Escalation | `reactions.escalate` in config | `agent-orchestrator.yaml.example` |
| Policy engine | `packages/core/src/policy-engine.ts` | New file |

## API

### Governance Plugin Interface

```typescript
export interface GovernancePlugin extends PluginModule {
  name: "governance";
  validateEvidence(bundle: EvidenceBundle): Promise<ValidationResult>;
  evaluateGate(pr: PullRequest): Promise<GateResult>;
  checkEscalation(session: Session): Promise<EscalationResult>;
  evaluatePolicy(pr: PullRequest, projectPolicy: Policy): Promise<PolicyResult>;
}
```

### Key Types

```typescript
type GateStatus = "UNLOCKED" | "BLOCKED" | "PENDING";
type EscalationReason = "inactivity" | "ci_repeated_failure" | "human_requested";

type GovernanceReason =
  | "ci_failure"
  | "coderabbit_not_approved"
  | "skeptic_failed"
  | "evidence_missing"
  | "policy_violation"
  | "escalation_required";

interface GovernanceDecision {
  gate: GateStatus;
  evidence: ValidationResult;
  policy: PolicyResult;
  escalation: EscalationResult | null;
  timestamp: string;
  reason: GovernanceReason;       // structured reason code
  detail?: string;                 // optional human-readable explanation
}
```

## Failure Modes

| Failure | Behavior | Recovery |
|---------|----------|----------|
| Governance plugin crashes | Fail-closed: block merge | Restart AO, re-evaluate |
| Policy YAML invalid | Log error, use defaults | Fix YAML, run `ao config-validate` |
| Evidence bundle missing | Block merge if `evidenceRequired: true` | Agent must add evidence |
| Escalation not acknowledged | Re-escalate after timeout | Human resolves or agent auto-closes |

## Open Questions

1. Should governance run before or after CodeRabbit? The Evidence Validator component may run before CodeRabbit to pre-filter low-quality submissions early. However, the full Governance Layer (Merge Gate Enforcer) must run after CodeRabbit when evaluating Gate `#2` (CodeRabbit approval), since it depends on that status. The "save CI compute" rationale is not applicable — CodeRabbit runs independently of CI. Timing should be determined by whether the governance step needs the CodeRabbit approval status.
2. Should `chore`/`docs` PRs be exempt from evidence requirements?
3. Should escalation auto-close PRs after N days with no human action?

## Related Beads

| Bead | Title |
|------|-------|
| bd-0cfv | SKIPPED skeptic verdict treated as success (should be fail-closed) |
| bd-1lni | Skeptic Gate infrastructure broken |
| bd-kvvx | Skeptic false-positive on PRs missing CR APPROVED |
| bd-io8q | Zero branch protection on main |
