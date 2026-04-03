---
title: Agent Architecture
purpose: Define repo boundaries and where new capabilities should land.
owner: jleechan
last_reviewed: 2026-04-02
source_of_truth: AGENTS.md + package layout
---

# Architecture

## Read this when
- adding a new capability
- deciding core vs plugin placement
- touching `packages/core`

## Must stay true
- Development hierarchy remains: AO worker → config → plugin → new plugin type → core.
- New behavior should prefer `packages/plugins/*` over `packages/core/*`.
- Fork isolation rule applies: minimize upstream-file diffs; prefer companion modules.
