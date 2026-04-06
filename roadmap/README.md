# Roadmap index (fork)

Design notes, audits, and rolling status for **jleechanorg/agent-orchestrator**. Upstream-facing docs live elsewhere; this folder is fork-first.

## Recent activity

### 2026-04-06
- PR #390 merged: evidence theater diagnosis + Fix 1 (bd-cam93, N/A scoping)
- ao-3327 dispatched for Fix 2 (bd-4ze23, agentRules media wire) + Fix 3 (bd-7s0d, claim floor)
- ao-3325 dispatched for PR #389 (conflicts + evidence section)
- Epic bd-vide1 created: path to true video evidence (tmux + UI + captions)
- **bd-elcfg / builtin eloop:** `evolveLoop` was already enabled in `~/.openclaw/agent-orchestrator.yaml`; added `antig-dispatch` to `autonomousFixScopes` (parity with jleechanclaw); `ai.agento.orchestrators` LaunchAgent restarted. Open: merge [PR #393](https://github.com/jleechanorg/agent-orchestrator/pull/393) for `agent-orchestrator.yaml.example` + close bd-elcfg.
- **Beads / `br`:** Fixed invalid `updated_at` strings (`+00:00Z`) in `.beads/issues.jsonl` that broke `br import` / `br ready`; `br sync --rebuild` + flush — see commit `929fffb6`.
- roadmap/video-evidence-roadmap.md created (rolling)
- `fix(cli): register gemini agent plugin` — [`45ecdf2a`](https://github.com/jleechanorg/agent-orchestrator/commit/45ecdf2a) on `fix/gemini-plugin-registration`

### 2026-04-05

- **Skill restoration (bd-pwku)** — Archived loose-md skills restored to **`~/.claude/skills/<name>/SKILL.md`**; repo **`.claude/skills/README.md`** + **`CLAUDE.md`** pointers; duplicate loose files removed. Details: [`skill-restoration.md`](./skill-restoration.md). Pre-change roadmap snapshot: **`~/Downloads/agent-orchestrator-roadmap-*`**.
- **Session registry harness** — New initiative: align `ao session ls` / metadata **`[working]`** with **tmux + JSONL ground truth** so operators are not misled by idle panes. Doc: [`session-registry-harness.md`](./session-registry-harness.md). Bead: **bd-9gvm** (related: **bd-3h9**).
- **Evolve loop & policy** — Landed: healthy-cycle fast path + session budget ([PR #380](https://github.com/jleechanorg/agent-orchestrator/pull/380)); Phase 7 recap + Phase 8 idle auto-cancel ([PR #381](https://github.com/jleechanorg/agent-orchestrator/pull/381)); Zero-Framework Cognition (ZFC) section in CLAUDE.md ([PR #382](https://github.com/jleechanorg/agent-orchestrator/pull/382)).
- **Skeptic** — `claude --print` runs from `/tmp` to avoid project `CLAUDE.md` hooks skewing evaluation (commit `7a9890f9`).

### Older entries

See individual docs below; long-form evolve-loop cycles remain in [`evolve-loop-findings.md`](./evolve-loop-findings.md).

## Documents by theme

| Topic | File |
|--------|------|
| Skill restoration (user scope vs repo) | [skill-restoration.md](./skill-restoration.md) |
| Session / CLI observability harness | [session-registry-harness.md](./session-registry-harness.md) |
| Evolve loop history & metrics | [evolve-loop-findings.md](./evolve-loop-findings.md) |
| Skeptic + AO worker architecture | [skeptic-ao-worker-architecture.md](./skeptic-ao-worker-architecture.md) |
| Harness engineering (Ryan talk) | [harness-engineering-v2.md](./harness-engineering-v2.md) |
| Autonomy / green loop | [autonomy-gaps.md](./autonomy-gaps.md), [green-loop-e2e.md](./green-loop-e2e.md), [7green-enforcement-gaps.md](./7green-enforcement-gaps.md) |
| API / rate limits | [api-rate-limit-mitigation.md](./api-rate-limit-mitigation.md), [gh-api-reduction-validation.md](./gh-api-reduction-validation.md) |
| Next priority batch | [next-priority-fixes.md](./next-priority-fixes.md) |
| Multi-CLI / TDD roadmap | [autonomous-orchestrator-multi-cli-design.md](./autonomous-orchestrator-multi-cli-design.md), [tdd-bead-roadmap-autonomous-orchestrator.md](./tdd-bead-roadmap-autonomous-orchestrator.md) |
| Zero-touch rate | [zero-touch-6green-rate.md](./zero-touch-6green-rate.md) |

## Beads

Canonical issue list: **`.beads/issues.jsonl`**. Use **`br`** to create/update/close issues.
