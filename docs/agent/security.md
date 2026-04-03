---
title: Agent Security
purpose: Capture trust boundaries for evidence and automation.
owner: jleechan
last_reviewed: 2026-04-02
source_of_truth: workflow policy + repository security docs
---

# Security

## Read this when
- changing evidence parsing logic
- modifying PR automation permissions
- adding external artifact sources

## Must stay true
- Evidence cannot rely on placeholders or simulated outputs.
- High-claim classes require multiple independent artifact types.
- Gate bypass paths (empty body, missing verdict) remain blocked.
