# Nextsteps — Skeptic Minimal Per-Repo Design — 2026-04-25

## Table of contents

- [Executive summary](#executive-summary)
- [Context](#context)
- [Bead index](#bead-index)
- [Work queue](#work-queue)
- [PR / merge state](#pr--merge-state)
- [Learnings pointer](#learnings-pointer)
- [Roadmap pointer](#roadmap-pointer)

---

## Executive summary

- **Outcome:** Assessed skeptic infrastructure across worldarchitect.ai and agent-orchestrator. Four parallel trigger paths found for skeptic eval: GHA Gate (green-gate.yml), GHA Cron (30min), Local Cron (10min, runLocalSkepticCron), and Manual (skeptic-self-verify.yml). Local cron is most responsive with SHA dedup; GHA cron is largely redundant.
- **Problem:** Per-repo code is larger than necessary — 3+ workflow files (green-gate, skeptic-cron, skeptic-self-verify, post-skeptic-verdict) where 1 thin skeptic-gate.yml should suffice. GHA cron runs every 30min when local cron at 10min is faster + smarter.
- **Decision:** User wants lifecycle-worker as primary eval engine, skeptic-cron GHA as backup catchup (hourly+), minimal per-repo GHA code. No redundant verdict posting.
- **Next:** Design and implement minimal skeptic-gate.yml (thin polling GHA) + convert skeptic-cron to hourly backup-only + update install-skeptic-ci-for-repo.sh.
- **Bead:** TBD after scoping.

---

## Context

Session started with question: "why do i even need the skeptic stuff in the worldai repo?" — user merged PR #6629 (skeptic-related) and questioned whether worldarchitect.ai needs skeptic-cron at all given lifecycle-worker already dispatches `ao skeptic verify`.

Investigation revealed worldarchitect.ai has 4 parallel trigger paths:
1. **GHA Gate** (`green-gate.yml`) — posts SKEPTIC_GATE_TRIGGER on PR events
2. **GHA Cron** (`skeptic-cron.yml`) — every 30 min, posts SKEPTIC_CRON_TRIGGER
3. **Local Cron** (`runLocalSkepticCron`) — every 10 min, direct SCM listing, SHA dedup
4. **Manual** (`skeptic-self-verify.yml`) — workflow_dispatch fallback

All route through lifecycle-manager → `ao skeptic verify` → VERDICT comment.

Key finding: `skeptic-gate.yml` is **absent** from worldarchitect.ai — the polling/merge-blocking role is played inconsistently by green-gate.yml. `post-skeptic-verdict.yml` (added 2026-04-24) has unknown purpose and may be redundant.

Minimal target: 1 thin GHA workflow + lifecycle-worker as primary + GHA cron as hourly backup.

---

## Bead index

| Bead | Title | Link |
|------|-------|------|
| bd-150d | Minimal skeptic per-repo design | [bd-150d](https://github.com/jleechanorg/agent-orchestrator/blob/jq-filter-fix/.beads/issues.jsonl#L1) |

---

## Work queue

1. **Design minimal skeptic-gate.yml** — tracks bd-150d.1
   - Thin GHA workflow: posts trigger comment → polls for VERDICT (up to 10min) → exits PASS/FAIL
   - No local execution, no API keys — pure polling wrapper
   - Should work for any repo with SKEPTIC_BOT_AUTHOR configured
   - File: `.github/workflows/skeptic-gate.yml` (or skeptic-gate-reusable.yml as reusable)
   - Dependencies: lifecycle-worker running `ao skeptic verify` and posting VERDICT

2. **Convert skeptic-cron.yml to hourly backup-only** — tracks bd-150d.2
   - Change interval from 30min to 60min (or configurable)
   - Keep as catchup mechanism only — lifecycle-worker is primary
   - Posts SKEPTIC_CRON_TRIGGER, lifecycle-manager picks up same as before
   - No merge action (already SKEPTIC_CRON_AUTO_MERGE=false)
   - Consider: can skeptic-cron be replaced by skeptic-cron-reusable.yml with `schedule: ["0 * * * *"]`?

3. **Deprecate/remove redundant workflows from worldarchitect.ai** — tracks bd-150d.3
   - Remove `post-skeptic-verdict.yml` if redundant with lifecycle-manager verdict posting
   - Deprioritize `skeptic-self-verify.yml` (keep as manual-only fallback)
   - `green-gate.yml` — keep if it does 6-green check before posting trigger; if not, fold into skeptic-gate.yml

4. **Update install-skeptic-ci-for-repo.sh** — tracks bd-150d.4
   - Add flag `--minimal` to install only skeptic-gate.yml (thin polling)
   - Skeptic-cron becomes opt-in `--with-cron --cron-interval=60`
   - Document the two modes: "minimal (lifecycle-worker primary)" vs "full (with GHA cron)"

5. **Resolve VERDICT author inconsistency** — tracks bd-150d.5
   - `skeptic-self-verify.yml` posts as `github-actions[bot]`, not `jleechan2015` (SKEPTIC_BOT_AUTHOR)
   - Normalize all automated verdicts to SKEPTIC_BOT_AUTHOR identity

---

## PR / merge state

- **PR #498** (agent-orchestrator): OPEN — jq-filter-fix branch, parentheses fix committed (`2ffdfef3`), CI + skeptic evaluation in progress
- **PR #6629** (worldarchitect.ai): **MERGED** — skeptic-related change the user merged; prompted this review

---

## Learnings pointer

- `~/roadmap/learnings-2026-04.md` — section: `2026-04-25 — skeptic minimal per-repo design` — four parallel trigger paths found in worldarchitect.ai; local cron (10min) more responsive than GHA cron (30min); skeptic-gate.yml absent, green-gate.yml plays inconsistent role; minimal per-repo setup = 1 thin GHA polling workflow + lifecycle-worker primary + hourly GHA cron backup.

---

## Roadmap pointer

- Updated `roadmap/README.md` — Recent activity (rolling) — added 2026-04-25 entry for skeptic minimal per-repo design session.
