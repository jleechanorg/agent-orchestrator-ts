# Fork Companion Audit Report — Phase A
**Date:** 2026-04-21
**Session:** worktree_upstream (branch test-conflicts, ahead of origin/main by 3 commits)
**Audit scope:** All 11 `fork-*.ts` companion files in `packages/core/src/`

---

## Summary Table

| File | LOC (src) | Live? | Primary Consumer(s) | Bucket | Rationale |
|------|-----------|-------|---------------------|--------|-----------|
| `fork-skeptic-extension.ts` | 67 | YES | `lifecycle-manager.ts:97` | **A** | Skeptic-review reaction — useful pattern for any AO setup running skeptic; no fork-specific deps |
| `fork-claim-verification.ts` | 257 | YES | `lifecycle-manager.ts:98` | **B** | Tied to fork's specific GHA skeptic-gate chain (precheck→trigger→poll→comment); not upstreamable |
| `fork-utils.ts` | 36 | YES | `lifecycle-manager.ts`, `review-backlog.ts`, `review-sla.ts`, `review-kpi.ts`, `review-atomic-rereview.ts`, `no-delta-watchdog.ts`, `fork-reaction-rfr.ts` | **A** | Shared session metadata helper — general utility upstream would accept |
| `fork-slash-command-routing.ts` | 87 | YES | `session-manager.ts`, re-exported via `utils.ts` | **C** | Only consumed by session-manager.ts; could be inlined there to reduce upstream diff surface |
| `fork-dead-agent.ts` | 63 | YES | `lifecycle-manager.ts:82` | **A** | Dead agent override is a general pattern; session lifecycle with agent liveness checks is upstream |
| `fork-reaction-handlers.ts` | 149 | YES | `lifecycle-manager.ts:70`, also re-exported via `index.ts` | **B** | `handleRequestMerge` + `handleParallelRetry` are fork-specific AO reactions with no upstream equivalent |
| `fork-reaction-retry-policy.ts` | 39 | YES | `lifecycle-manager.ts:100` | **A** | General retry cap policy (3 for send-to-agent, Infinity for others) — could upstream with minor generalisation |
| `fork-reaction-rfr.ts` | 282 | YES | `lifecycle-manager.ts:71` | **B** | `handleRespawnForReview` is tightly coupled to AO respawn logic, session metadata keys (`pr_respawned`), and AO-specific observer API |
| `fork-lifecycle-manager.ts` | 237 | YES | `lifecycle-manager.ts:54` | **B** | Rate-limit detection and project-pause are fork-specific (specific rate-limit banner parsing, Discord pause notifications) |
| `fork-lifecycle-postmerge.ts` | 237 | YES | `lifecycle-manager.ts:16` | **B** | Post-merge co-worker reaping is specific to the fork's multi-worker session model; upstream does not have this pattern |
| `fork-lifecycle-kki-override.ts` | 38 | YES | `lifecycle-manager.ts:69` | **B** | Very specific edge-case override (killed→merged when SCM confirms PR merged) — fork-specific |

**Total LOC across all 11 files: 1,490**

---

## Bucket Breakdown

### Bucket A — Upstream-worthy (~228 LOC)

| File | LOC | Upstream Acceptability |
|------|-----|----------------------|
| `fork-skeptic-extension.ts` | 67 | High — skeptic integration pattern; no fork-specific deps |
| `fork-utils.ts` | 36 | High — generic session metadata helper |
| `fork-dead-agent.ts` | 63 | Medium-High — general dead-agent detection; depends on upstream having a status/transition model |
| `fork-reaction-retry-policy.ts` | 39 | High — simple cap policy; only requires `action` string comparison |

**Action:** Prepare as upstream PR candidates. Ensure each module has no fork-only imports before contributing.

### Bucket B — Fork-only, keep as companions (~1,175 LOC)

All 7 remaining files are tightly coupled to fork-specific infrastructure:

- **`fork-claim-verification.ts`** — GHA skeptic-gate chain (fork-specific workflow)
- **`fork-reaction-handlers.ts`** — `request-merge` and `parallel-retry` are AO-specific reactions
- **`fork-reaction-rfr.ts`** — AO respawn + observer API + fork session metadata keys
- **`fork-lifecycle-manager.ts`** — rate-limit banner parsing (specific to Claude Code/OpenCode output), Discord notifications, project-level pause
- **`fork-lifecycle-postmerge.ts`** — fork's multi-worker co-session model
- **`fork-lifecycle-kki-override.ts`** — edge-case status override for fork's killed→merged race condition

**Action:** Keep as `fork-*.ts` companions. These are correctly isolated from upstream core.

### Bucket C — Inline candidate (~87 LOC)

| File | LOC | Rationale |
|------|-----|-----------|
| `fork-slash-command-routing.ts` | 87 | Only consumed by `session-manager.ts` (and re-exported via `utils.ts`). Could be inlined into `session-manager.ts` to reduce diff surface. However, the re-export via `utils.ts` means other consumers get it from there — verify before inlining. |

**Action:** Investigate whether `utils.ts` re-export is the intended interface. If yes, keep as companion. If the re-export is only for backward compat, could inline into `session-manager.ts`.

---

## LOC Per Bucket

| Bucket | LOC | Files |
|--------|-----|-------|
| A (upstream-worthy) | 228 | 4 files |
| B (fork-only) | 1,175 | 6 files |
| C (inline candidate) | 87 | 1 file |
| **Total** | **1,490** | **11 files** |

---

## Key Findings

### 1. Zero dead companions — all 11 files are live
All 11 `fork-*.ts` files are imported and used. The question in the roadmap ("Are `fork-lifecycle-manager.ts`, `fork-lifecycle-postmerge.ts`, `fork-lifecycle-kki-override.ts` actually loaded?") is answered: **yes, all three are imported by `lifecycle-manager.ts`**.

### 2. `fork-utils.ts` is the most widely shared companion
It has 6 non-lifecycle consumers plus `fork-reaction-rfr.ts`. It is the most upstream-worthy candidate (Bucket A) because it has the broadest reuse surface and no fork-specific logic.

### 3. `fork-slash-command-routing.ts` has two consumers
Not just `session-manager.ts` — it is also re-exported via `utils.ts`, which means other modules may consume it through `utils.ts`. The re-export makes it a public interface rather than an internal detail. This argues **against** inlining it into `session-manager.ts` and suggests it should stay as a named companion.

### 4. Bucket B (fork-only) is dominant — ~79% of companion LOC
1,175 of 1,490 LOC (79%) are in Bucket B. These cannot be upstreamed. The correct strategy for these is **plugin extraction** (Phase C of the restructure roadmap) rather than upstream contribution.

### 5. `fork-skeptic-extension.ts` and `fork-reaction-retry-policy.ts` are the cleanest upstream candidates
Both are single-responsibility, have minimal deps, and implement patterns (skeptic reaction, retry cap) that are useful beyond this fork. Recommend preparing upstream PRs for these two first.

### 6. Rate-limit detection in `fork-lifecycle-manager.ts` is highly Claude-Code-specific
The `parseRateLimitReset` function parses Claude Code / OpenCode terminal output (`usage limit reached`). This is not upstreamable as-is — the banner format is specific to the Claude Code binary.

---

## Test Coverage

A liveness test suite was written at:
```text
packages/core/src/__tests__/fork-companion-audit.test.ts
```

It verifies:
- All 11 files exist on disk
- Each exports its expected value exports
- Each fork companion is imported by its primary consumer (`lifecycle-manager.ts`, `session-manager.ts`, etc.)

**Result: 42 tests, all passing.**

---

## Next Steps (Phase B onwards)

Per the roadmap, the next steps are:
- **Phase B:** Config-driven behavior audit — identify hardcoded fork logic in `lifecycle-manager.ts` that could move to `agent-orchestrator.yaml`
- **Phase C:** Plugin extraction — extract Bucket B fork-specific logic into new plugin packages (zero conflict)
- **Phase D:** Upstream contribution candidates — prepare PRs for `fork-skeptic-extension.ts` and `fork-reaction-retry-policy.ts`
- **Phase E:** Inline modification reduction — reduce upstream diff surface in `lifecycle-manager.ts`

---

*Audit completed by MiniMax Coder Agent — Phase A fork-companion audit*
