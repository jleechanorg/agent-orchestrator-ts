# Harness Engineering v2 — Ryan Talk Insights

**Date**: 2026-03-26
**Source**: OpenAI Ryan talk on Codex harness engineering patterns
**Epic**: Zero-touch rate 70% → 95%

## Context

Ryan's team at OpenAI runs Codex agents in a tmux+local-app pattern strikingly similar to AO. Key insight: **"multiple shots on goal"** — enforce guardrails at coding time (agentRules), test time (wholesome tests), AND review time (dedicated review agents). Single-point enforcement fails ~28% of the time (our [agento] prefix gap proves this).

## Initiatives

### 1. PR Media Proof (bd-mpr) — P1

Agents must attach visual proof to every PR. Ryan's exact quote: "I'm expecting that they did the job and that they can prove to me that the code is worth merging."

- **What**: Screenshots/video attached to PR body showing the change works
- **How**: agentRules + PR media skill + chrome MCP for web changes
- **Impact**: Faster review cycles, better evidence for /er gate, catches UI regressions
- **Effort**: 1 afternoon (Ryan's estimate for similar tooling)

### 2. Wholesome Tests (bd-wht) — P1

Stripe-originated pattern: tests on code STRUCTURE, not just behavior. Ryan: "You can scan the repo to see if codex is abusing disabling my eslint."

- **What**: CI checks that assert structural invariants on the diff
- **How**: GitHub Action + wholesome.test.ts with structural assertions
- **First check**: [agento] prefix on PR titles (supplements bd-pfx runtime hooks)
- **Future checks**: no @ts-ignore, no eslint-disable, fork isolation compliance, evidence sections
- **Impact**: "Multiple shots on goal" for every quality dimension

### 3. Architecture Map (bd-arc) — P2

Ryan: "Architecture.md gives a high-level lay of the land so agents can efficiently page in context." Reference: Matt Rickard's blog post on codebase maps.

- **What**: docs/architecture.md with package graph, plugin system guide, "if X then also Y"
- **How**: Progressive disclosure index — agents.md/CLAUDE.md points to deeper docs per persona
- **Impact**: Reduces context waste from agents exploring wrong packages

### 4. Review-Fix Respawn (bd-rfr) — P1

When CR posts CHANGES_REQUESTED and the worker is dead, spawn a fresh worker with pre-loaded review context. Currently 2 of 4 open PRs are stuck with no worker.

- **What**: Escalation action that spawns fresh worker when send-to-agent fails on CHANGES_REQUESTED PR
- **How**: New action type in reactions schema, lifecycle-manager integration
- **Impact**: ~10-15pp toward 95% zero-touch rate

## Principles from Ryan Talk

1. **Principles over procedures** in agent docs — "encode semantic meaning" not micro-instructions
2. **Code is free** — build bespoke throwaway tools for agents (observability, capture, validation)
3. **100% code coverage** is achievable because agents are patient and have no feelings
4. **Progressive disclosure** — index doc points to persona-specific deeper docs, agent discovers what's relevant
5. **"Why hasn't the agent done this already?"** — the right question for systems thinking

## Priority Order

1. **bd-pfx** (in progress, ao-1025) — prefix enforcement hooks
2. **bd-rfr** — review-fix respawn (unblocks 2 stuck PRs immediately)
3. **bd-wht** — wholesome tests (supplements bd-pfx with CI-time enforcement)
4. **bd-mpr** — PR media proof (highest long-term leverage)
5. **bd-arc** — architecture map (reduces context waste)

## Success Criteria

- Zero-touch rate: 70% → 85% (after bd-pfx + bd-rfr)
- Zero-touch rate: 85% → 95% (after bd-wht + bd-mpr reduce review friction)
- Agent context efficiency: measurable reduction in "exploring wrong package" patterns (after bd-arc)
