# Next priority fixes (rolling index)

**Created:** 2026-03-24  
**Beads epic:** `bd-8wm` (EPIC: Next priority fixes — send path, namespace, merge policy, evidence)  
**Related roadmaps:** [autonomy-blockers-v2.md](./autonomy-blockers-v2.md) (bd-ara), [green-loop-e2e.md](./green-loop-e2e.md) (bd-y5v), [api-rate-limit-mitigation.md](./api-rate-limit-mitigation.md)

## Purpose

After hardening PR checkout (GraphQL burn), merge logging, and curl token handling, the remaining failures are mostly **runtime reliability**, **namespace consistency**, and **policy**. This document is the human-readable index; authoritative task state lives in **beads** (`.beads/issues.jsonl`) under epic **`bd-8wm`**.

## Tier 1 — Do these first (P0 / blocking symptoms)

| Theme | Beads | Why it still matters |
|--------|--------|----------------------|
| **`ao send` / dead agent CLI** | **bd-tln** (canonical), **bd-orch2v3**, **bd-i9o** (duplicate narrative — track with bd-tln), **bd-hvx** (superseded by bd-tln per description) | Paste hits bash after the agent exits → workers idle; must be fixed in tmux/session layer + agent restart contract. |
| **Enter timing / long paste** | **bd-qhf**, **bd-0gb** | Upstream ComposioHQ **#373** class of bugs; complements bd-tln (timing vs dead process). |
| **Stale sessions vs spawn gate** | **bd-ara.3**, **bd-s4t**, **bd-s4t.1** | Merged PRs still running; reaper gaps; blows past session caps. Verify recent lifecycle kills vs beads still open. |
| **Merge bypass** | **bd-u8p** | Agents must not merge outside orchestrator merge gate; hooks + rules + product enforcement. |
| **Worktree pruner destroys active sessions** | **bd-6ql** | `pruneStaleWorktrees` tmux name mismatch deletes ALL active worktrees; data-destroying bug. |

## Tier 2 — Namespace and harness (P1 but systemic)

| Theme | Beads | Notes |
|--------|--------|--------|
| **Canonical config / data dir** | **bd-oji**, **bd-e4t**, **bd-4n8**, **bd-6rh** | CWD-derived config discovery → wrong `~/.agent-orchestrator/{hash}` namespace; lifecycle-worker sees zero sessions. Align launchd/`AO_CONFIG_PATH` and add harness checks. |

## Tier 3 — Process, API budget, evidence

| Theme | Beads | Notes |
|--------|--------|--------|
| **CodeRabbit state** | **bd-77b** | COMMENTED-after-APPROVED blocks “6 green”; ops/config/process. |
| **Rate limits** | **bd-gim** (+ children / bd-8y9 family) | Batch/skip/throttle; see gh-api docs in `roadmap/`. |
| **Evidence claims** | **bd-7ay** | Fail-closed PR-lifecycle vs pipeline E2E; merge gate condition 6. |

## Duplicate / consolidation note

- **bd-i9o** and **bd-tln** describe the same root cause; **bd-tln** is the canonical technical spec. Beads link: `related` edge between them.
- **bd-hvx** is superseded by **bd-tln** (`related` edge with `superseded-by` metadata). Keep open until bd-tln lands, then close.
- **bd-5zr** was previously marked superseded; not present in current JSONL (already removed).
- **bd-qhf**, **bd-s4t**, **bd-s4t.1**, **bd-u8p** bumped from P1→P0 to align with Tier 1 placement (2026-03-24).

## Suggested implementation order

1. **bd-6ql** — fix `pruneStaleWorktrees` tmux name mismatch (data-destroying; blocks safe cleanup).
2. **bd-qhf** / **bd-0gb** — confirm fork parity with upstream #373; reduces false “idle” from swallowed Enter.
3. **bd-tln** — dead-agent detection + `getRestartCommand()` (unblocks review-check / ao send).
4. **bd-oji** + **bd-e4t** + **bd-4n8** — deterministic config path; fail loudly on mismatch.
5. **bd-u8p** — merge policy (config + enforcement).
6. Re-verify **bd-s4t** / **bd-s4t.1** / **bd-ara.3** against current `main`; close beads if already implemented.
7. **bd-77b**, **bd-gim**, **bd-7ay** in parallel as bandwidth allows.

## Beads graph notes

- **bd-s4t.1** and **bd-gim** are linked to **bd-8wm** with **`related`** (not `parent-child`) because adding a parent-child edge would create a dependency cycle in the current graph.
- **bd-8wm** has **`related`** edges to **bd-ara** and **bd-y5v** so this index stays tied to the older autonomy / green-loop epics without implying a blocking order.

## Changelog

| Date | Change |
|------|--------|
| 2026-03-24 | Initial doc; epic **bd-8wm**; parent-child + related links as documented above. **bd-6rh** priority raised P2→P1; **bd-u8p** / **bd-0gb** notes updated. |
| 2026-03-24 | Data hygiene pass: added **bd-6ql** to Tier 1 (worktree pruner bug). Bumped bd-qhf/bd-s4t/bd-s4t.1/bd-u8p P1→P0 to match Tier 1. Added bd-hvx superseded-by bd-tln link. Noted bd-5zr already removed. |
