# Skeptic chain decoupling — three chapters, one test

## Table of contents

- [1. Three-chapter history](#1-three-chapter-history)
  - [Chapter 1: The Initial Decoupling (PR #497)](#chapter-1-the-initial-decoupling-pr-497)
  - [Chapter 2: The Unintentional Re-coupling (PR #654)](#chapter-2-the-unintentional-re-coupling-pr-654)
  - [Chapter 3: Re-decoupling via Trigger Check Priority (PR #661)](#chapter-3-re-decoupling-via-trigger-check-priority-pr-661)
- [2. Decoupling contract](#2-decoupling-contract)
  - [Invariant A: Unconditional Call Site](#invariant-a-unconditional-call-site)
  - [Invariant B: Open batch boundary without recency/draft filter](#invariant-b-open-batch-boundary-without-recencydraft-filter)
  - [Invariant C: Trigger comment check takes precedence over age check](#invariant-c-trigger-comment-check-takes-precedence-over-age-check)
- [3. Regression test contract](#3-regression-test-contract)
  - [Case I: Stale PR + Fresh trigger comment](#case-i-stale-pr--fresh-trigger-comment)
  - [Case II: Fresh PR + No trigger comment](#case-ii-fresh-pr--no-trigger-comment)
  - [Case III: Stale PR + No trigger comment + listPRComments missing](#case-iii-stale-pr--no-trigger-comment--listprcomments-missing)
- [4. Acceptance criteria checklist](#4-acceptance-criteria-checklist)
- [5. Citation block](#5-citation-block)

---

## 1. Three-chapter history

The `agent-orchestrator` skeptic cron is responsible for running periodic local evaluations on open pull requests to check for the `/skeptic` trigger. The history of this cron's coupling to PR recency spans three distinct chapters:

### Chapter 1: The Initial Decoupling (PR #497)
* **Goal**: Decouple the execution of local skeptic reviews from the project-level `backfillAllPRs` setting.
* **Mechanism**: The call site for `runLocalSkepticCron` in [lifecycle-manager.ts](../packages/core/src/lifecycle-manager.ts) was modified to remove the `backfillAllPRs !== false` check, ensuring that the local cron is unconditionally executed during project poll cycles.
* **Citation Proof**: PR [PR #497](https://github.com/jleechanorg/agent-orchestrator/pull/497) (Merge commit `e1f11d0033e0a7a7c57ff981a43de26389fb1af8`), modified the call site to runLocalSkepticCron:
```diff
       if (scopedProjectId) {
         const skepticProject = config.projects[scopedProjectId];
-        if (skepticProject && skepticProject.backfillAllPRs !== false) {
+        if (skepticProject) {
           void runLocalSkepticCron(
             { registry, sessionManager, observer },
             { projectId: scopedProjectId, project: skepticProject, activeSessions, correlationId },
          ).catch(skepticCronErr => {
```

### Chapter 2: The Unintentional Re-coupling (PR #654)
* **Goal**: Optimize the skeptic cron to support explicit model fallbacks and list fallback chains (e.g. minimax/agy).
* **Mechanism**: To prevent scanning every stale PR in large repositories, a 24-hour age/recency filter was added to the top of `runLocalSkepticCron` in [skeptic-cron-local.ts](../packages/core/src/skeptic-cron-local.ts) during `eligiblePRs` collection. This caused the cron to discard any PR that hadn't been modified in the last 24 hours *before* checking if there was a fresh `/skeptic` comment, breaking the manual re-trigger flow for older PRs and silencing skeptic evaluations across the worldarchitect fleet.
* **Citation Proof**: PR [PR #654](https://github.com/jleechanorg/agent-orchestrator/pull/654) (Merge commit `8dfd5c207f2963e2ff9964f1d6d8ae5855538a86`), modified the eligiblePRs filter in `packages/core/src/skeptic-cron-local.ts`:
```diff
-  // Collect eligible PRs (non-draft) in a single pass before running
-  const eligiblePRs = openPRs.filter(pr => !pr.isDraft);
+  // Collect eligible PRs (non-draft, modified within last 24 hours) in a single pass before running
+  const eligiblePRs = openPRs.filter((pr) => {
+    if (pr.isDraft) return false;
+    if (pr.updatedAt) {
+      const updatedAtMs = Date.parse(pr.updatedAt);
+      if (Number.isFinite(updatedAtMs)) {
+        const ageMs = Date.now() - updatedAtMs;
+        const oneDayMs = 24 * 60 * 60 * 1000;
+        if (ageMs > oneDayMs) {
+          return false;
+        }
+      }
+    }
+    return true;
+  });
```

### Chapter 3: Re-decoupling via Trigger Check Priority (PR #661 - Proposed)
* **Status**: **OPEN / Proposed** (as of 2026-06-09). The decoupling mechanism described below is currently under review in [PR #661](https://github.com/jleechanorg/agent-orchestrator/pull/661) and will become active once merged.
* **Goal**: Re-decouple the skeptic cron from PR recency by prioritizing comment triggers over age limits.
* **Mechanism**: The 24-hour age check was moved inside `evaluateOnePR` in `packages/core/src/skeptic-cron-local.ts` and gated behind the SCM comments retrieval. By checking comments first, any PR (regardless of age) containing a valid `/skeptic` trigger comment is evaluated. The 24-hour age check is preserved only as a fallback when the SCM comment API is unavailable.
* **Citation Proof**: PR [PR #661](https://github.com/jleechanorg/agent-orchestrator/pull/661) (Head commit `1a9767f55c07d3c848cbdcdff421b50faff7c68b`), moved the age check logic inside evaluateOnePR in `packages/core/src/skeptic-cron-local.ts`:
```diff
+    let isTriggerPresent = false;
 
-    // 2. If already successfully evaluated for this HEAD SHA, skip entirely
-    if (headSha && lastEvaluatedShaByPR.get(cacheKey) === headSha) {
-      ...
-    }
+    // 2. Fetch comments and check for a trigger comment (required for both recent and stale PRs)
     if (scm?.listPRComments) {
       try {
         const comments = await scm.listPRComments(pr);
-        if (!hasValidTriggerComment(comments)) {
+        if (hasValidTriggerComment(comments)) {
+          isTriggerPresent = true;
+        } else {
           // No trigger comment, so it's safe to cache the updatedAt so we don't check comments again
           if (pr.updatedAt) {
             lastCheckedUpdatedAtByPR.set(cacheKey, pr.updatedAt);
           }
           return false;
         }
       } catch (err) {
         ...
       }
     } else {
+      // Fallback: if scm.listPRComments is missing, fall back to the 24-hour PR age check
+      if (pr.updatedAt) {
+        const updatedAtMs = Date.parse(pr.updatedAt);
+        if (Number.isFinite(updatedAtMs)) {
+          const ageMs = Date.now() - updatedAtMs;
+          const oneDayMs = 24 * 60 * 60 * 1000;
+          if (ageMs > oneDayMs) {
+            // Older than 24h, skip
+            return false;
+          }
+        }
+      }
+    }
```

---

## 2. Decoupling contract

To prevent future regression details, any modifications to the skeptic cron behavior must adhere to the following three invariants:

### Invariant A: Unconditional Call Site
The call site for the local cron in `packages/core/src/lifecycle-manager.ts` must invoke `runLocalSkepticCron` unconditionally for any configured project without guarding on project backfill parameters (e.g. `backfillAllPRs`).

### Invariant B: Open batch boundary without recency/draft filter
The top-level batch collection `eligiblePRs` in `packages/core/src/skeptic-cron-local.ts` must filter out only draft pull requests (`pr.isDraft`). No age-based, recency-based, or activity-based filtering is allowed at this public boundary.

### Invariant C: Trigger comment check takes precedence over age check
Inside `evaluateOnePR`, retrieval of trigger comments via the SCM plugin must happen prior to any fallback age filtering. If a `/skeptic` trigger comment is found, the PR must proceed to evaluation regardless of the time elapsed since its last update.

---

## 3. Regression test contract

> [!NOTE]
> The regression tests listed below are implemented as part of [PR #661](https://github.com/jleechanorg/agent-orchestrator/pull/661) and are not yet merged into the `main` branch.

The decoupling invariants are enforced via three specific test cases in [skeptic-cron-local.test.ts](../packages/core/src/__tests__/skeptic-cron-local.test.ts) (specifically the test cases verifying decoupling):

### Case I: Stale PR + Fresh trigger comment
* **Assertion**: PR is modified > 24 hours ago but has a valid `isSkepticTrigger` comment. The local cron must evaluate the PR.
* **Positive Log Verification**: Expect operation log `skeptic.cron.evaluating` with the matching `prNumber` and `outcome: "success"`.
* **Test Reference**: skeptic-cron-local.test.ts (test: `evaluates PRs modified more than 24 hours ago if they have a trigger comment`).

### Case II: Fresh PR + No trigger comment
* **Assertion**: PR is modified within the last 24 hours. If comments are missing or check is bypassed, the PR is evaluated (ensuring prompt check coverage for active work).
* **Test Reference**: skeptic-cron-local.test.ts (test: `evaluates PRs modified within the last 24 hours`).

### Case III: Stale PR + No trigger comment + listPRComments missing
* **Assertion**: SCM comment API is missing (e.g. plugin not fully initialized or unsupported), and the PR is modified > 24 hours ago. The cron must skip the PR.
* **Log Verification**: Expect the evaluation to return `0` with no evaluator run.
* **Test Reference**: skeptic-cron-local.test.ts (test: `falls back to 24h PR age check if listPRComments is missing`).

---

## 4. Acceptance criteria checklist

Before any pull request modifying the skeptic cron is merged, the following criteria must be verified:
- [ ] **Invariant A Met**: Call site in `lifecycle-manager.ts` does not check `backfillAllPRs`.
- [ ] **Invariant B Met**: `eligiblePRs` filter in `skeptic-cron-local.ts` filters only drafts (`!pr.isDraft`).
- [ ] **Invariant C Met**: Age limit is checked inside `evaluateOnePR` only if SCM comments list returns no trigger or is missing.
- [ ] **Case I Verified**: `evaluates PRs modified more than 24 hours ago if they have a trigger comment` test passes.
- [ ] **Case II Verified**: `evaluates PRs modified within the last 24 hours` test passes.
- [ ] **Case III Verified**: `falls back to 24h PR age check if listPRComments is missing` test passes.
- [ ] **Operator Idle Logging**: When no PRs are eligible for evaluation in the last 10 minutes, the cron completes with count `0` and does not spam console logs, allowing operators to distinguish 'system off' from 'no work to do' by checking the observer operation log `skeptic.cron.sha_dedup_skip`.

---

## 5. Citation block

1. **PR #497 Call Site Decoupling**: [PR #497](https://github.com/jleechanorg/agent-orchestrator/pull/497), Merge Commit: `e1f11d0033e0a7a7c57ff981a43de26389fb1af8`, File: `packages/core/src/lifecycle-manager.ts` (runLocalSkepticCron call site)
2. **PR #654 Recency Filter Re-coupling**: [PR #654](https://github.com/jleechanorg/agent-orchestrator/pull/654), Merge Commit: `8dfd5c207f2963e2ff9964f1d6d8ae5855538a86`, File: `packages/core/src/skeptic-cron-local.ts` (eligiblePRs filter)
3. **PR #661 Decoupling Restoration**: [PR #661](https://github.com/jleechanorg/agent-orchestrator/pull/661), Head Commit: `1a9767f55c07d3c848cbdcdff421b50faff7c68b`, File: `packages/core/src/skeptic-cron-local.ts` (evaluateOnePR age check, eligiblePRs draft check)
4. **Decoupling Regression Tests**: Head Commit: `1a9767f55c07d3c848cbdcdff421b50faff7c68b`, File: `packages/core/src/__tests__/skeptic-cron-local.test.ts` (Stale PR trigger, Fresh PR, and listPRComments missing fallback tests)
