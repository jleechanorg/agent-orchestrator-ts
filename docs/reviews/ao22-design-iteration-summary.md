# AO22 Design Iteration Summary

## What was updated

1. `docs/design/feedback-routing-and-followup-design.md`
   - Formalized the full pipeline: report -> issue -> agent-session -> PR.
   - Added explicit sections for:
     - trigger conditions,
     - session spawning contract,
     - target selection (upstream vs fork),
     - PR creation/linking requirements,
     - idempotency/retry semantics,
     - governance hooks per fork-owner policy.

2. `docs/design/feedback-pipeline-explainer.html`
   - Added a durable architecture explainer page (non-PR-specific).
   - Mirrors the same six design contracts and the formal pipeline.

## Intent

This iteration is design formalization only. No runtime/code behavior was introduced by this request.

## Feedback incorporated

- Added a dedicated `Consent Gates (Default Policy)` section with hard defaults for non-AO dogfooding:
  - explicit approval required for `createFork`, `createPR`, and upstream/fork target switching.
- Clarified that project-level override is optional and only active when explicitly enabled by the owner.
- Expanded journal behavior in plain language to describe how records are written/updated/retried.
- Added a minimal journal schema example for the feedback pipeline.

## Ready for review

The docs now provide a deterministic contract for implementing fork-aware report->issue->session->PR execution in follow-up PRs.
