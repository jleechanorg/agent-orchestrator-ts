---
title: Agent Reliability
purpose: Document operational expectations and quick debugging entry points.
owner: jleechan
last_reviewed: 2026-04-02
source_of_truth: operational scripts + workflows
---

# Reliability

## Read this when
- debugging failed gates
- triaging worker churn
- investigating flaky automation

## Must stay true
- Validation gates fail closed on missing evidence.
- Checks emit actionable error text (what is missing, not just failed/success).
- Changes to required gates are reflected in docs and repo config.
