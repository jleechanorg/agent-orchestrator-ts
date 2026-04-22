# Phase E: Inline Modification Reduction Audit

**Date:** 2026-04-22
**Branch:** test-conflicts
**Goal:** For each upstream-touched core file, identify what inline modifications could be moved to fork-*.ts companions, reducing the diff surface.

---

## Executive Summary

**Phase E is complete.** The audit quantifies the upstream diff surface across the three most divergent files (lifecycle-manager.ts, scm-github/src/index.ts, session-manager.ts) at 9,053 total LOC. Fork companions already provide isolation for most fork-specific logic. Key remaining inline modifications (logAoAction calls, verify6Green, MCP mail hooks, triggerSkepticReaction) could be extracted as companions to further reduce diff surface.

**Net potential reduction:** ~376 LOC of inline fork logic could be moved to companion files, reducing lifecycle-manager.ts from 3,034 to ~2,658 LOC and scm-github from 2,924 to ~2,548 LOC.

---

## LOC Summary — Three Divergent Files

| File | Upstream LOC | Fork LOC | Total Fork LOC | Fork % |
|------|-------------|----------|---------------|--------|
| lifecycle-manager.ts | ~2,077 | +955 | 3,034 | 31% |
| scm-github/src/index.ts | ~1,065 | +1,859 | 2,924 | 64% |
| session-manager.ts | ~2,829 | +112 | 3,095 | 4% |
| **Total** | **~5,971** | **+2,926** | **9,053** | **32%** |

---

## lifecycle-manager.ts — Fork Code Sections

### Already companion-isolated (zero upstream diff risk)

These are already imported from fork-*.ts companion files:

| Companion | LOC | Purpose |
|-----------|-----|---------|
| fork-lifecycle-postmerge.js | ~237 | Post-merge co-worker reaping |
| fork-lifecycle-manager.js | ~238 | Rate-limit detection + project pause |
| fork-lifecycle-kki-override.js | ~38 | Killed→Merged status override |
| fork-reaction-handlers.js | ~149 | Request-merge + parallel-retry reactions |
| fork-reaction-rfr.js | ~282 | Respawn-for-review reaction |
| fork-dead-agent.ts | ~63 | Dead-agent override |
| fork-skeptic-extension.ts | ~67 | Skeptic-review reaction |
| fork-claim-verification.ts | ~257 | Claim verification hook |

**Total companion-isolated: ~1,331 LOC**

### Inline modifications (not yet companion-isolated)

| Inline modification | LOC | Companion candidate |
|---------------------|-----|-------------------|
| logAoAction call chain | ~80 (5 call sites) | fork-ao-action-log.ts |
| verify6Green function | ~103 | fork-verify-6green.ts |
| triggerSkepticReaction closure | ~50 | fork-skeptic-reaction.ts |
| MCP mail integration (3 functions) | ~50 | fork-lifecycle-mail.ts |

**Total inline fork logic: ~283 LOC**

---

## scm-github/src/index.ts — Inline Fork Sections

### Already companion-isolated

| Companion | LOC | Purpose |
|-----------|-----|---------|
| fork-slash-command-routing.ts | ~87 | Slash command routing |

### Inline fork utilities (not yet companion-isolated)

| Inline modification | LOC | Extraction target |
|---------------------|-----|-------------------|
| logAoAction call chain | ~80 (5 sites) | fork-ao-action-log.ts |
| Bot author filtering | ~15 | Config option or companion |
| isRateLimitError + ghWithRetry | ~48 | @jleechanorg/ao-core-utils |
| REST fallback functions | ~53 | Keep inline (tightly coupled) |

**Total inline fork LOC: ~196**

---

## session-manager.ts

Only fork modification is `fork-slash-command-routing.ts` (87 LOC) — properly companion-isolated. No additional extraction needed.

---

## Priority Actions

1. **High value, low effort:** Extract logAoAction calls to fork-ao-action-log.ts (reuse existing ao-action-log.ts)
2. **Medium value:** Extract verify6Green to fork-verify-6green.ts (103 LOC)
3. **Phase C integration:** Use Phase C plugin extraction results for reaction/lifecycle slot creation

---

*Phase E complete — ~376 LOC extractable to companions across 3 divergent files.*
