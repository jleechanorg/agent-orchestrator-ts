# Evidence standards (jleechanorg/agent-orchestrator)

This directory holds **policy and reviewer-facing** material for PR evidence. **Machine-enforced** rules live in `.github/workflows/wholesome.yml` and `.github/workflows/evidence-gate.yml` (Evidence Bundle v2). The docs here extend those gates with **human review** expectations and merge confidence.

## Principles (upgrade model)

1. **Claims without artifacts are insufficient.** Narrative alone (“fixed the bug”, “works in prod”) is **INSUFFICIENT** for substantive implementation work unless mapped to verifiable artifacts.
2. **Reproducible, human-verifiable bundles** are required for every **substantive implementation** task (features, behavior changes, non-trivial refactors). Use `## Evidence` + Evidence Bundle v2 in `CLAUDE.md`.
3. **Non-unit claim classes** — CI requires **`**Agent screen recording**:`** (or **`**Screen recording**:`**) with **HTTPS video** + **caption** in the block, **self-produced in a sandbox run** (Cursor-style), **in addition to** terminal media + logs. **`unit`** skips this. See **`agent-screen-recording.md`**.
4. **UI / interactive work** — Prefer **video** of key user flows, plus **screenshots** of critical **before** and **after** states (same viewport/scale when comparing). If the change is non-visual, state why under **UI media** or use `N/A - no UI changes` only when accurate.
5. **Command logs** — Include real **terminal output** (fenced logs) showing the commands reviewers can repeat. Map each important claim to a log line or artifact.
6. **Self-validation** — Run verification in a **clean / isolated** context when practical (fresh worktree, no dirty toggles). Include **negative or error-path** checks where behavior matters. **Revert** temporary debug flags, `SKIP_*` env hacks, or one-off test-only edits before final push.
7. **Optimize for fast review** — Lead with: what changed, how to reproduce, where to look in media/logs, and PASS/FAIL verdict. Avoid burying proof under long prose.

See **`reviewer-checklist.md`** for a short pass/fail list.

## How this ties to automation

| Layer | Role |
|--------|------|
| **Evidence Gate + Wholesome (`evidence-gate.yml`, `wholesome.yml`)** | Deterministic checks: `## Evidence`, repro gist URL, terminal media + caption (tmux/terminal context), fenced terminal test output, UI media or exact `N/A - no UI changes`, **for non-unit claim class: `**Agent screen recording**` video URL + caption in block**, anti-placeholder rules. Fails closed in CI. |
| **`/er` (evidence review)** | **Merge-gate step 6** in `CLAUDE.md` (7-green). Human or agent uses the reviewer checklist + claim-class matrix to decide if evidence matches the **claimed** class. `/er` is **not** a substitute for CI: it validates *substance* and mapping, not YAML syntax. |
| **Skeptic Gate** | Independent LLM pass over merge readiness (including evidence plausibility vs 7-green). Complements `/er`; does not remove the need for real artifacts. If Skeptic is SKIPPED in CI, follow fork policy in `CLAUDE.md` (local `ao skeptic verify` for a real VERDICT when required). |

**Order of trust:** CI gates block malformed bundles → `/er` + reviewers validate claim↔artifact fit → Skeptic catches inconsistencies across the full gate story.

## Pointers

- Policy: `CLAUDE.md` — **Evidence Bundle v2**, **Evidence claim-class matrix**, **7-green**
- Local preflight: `.claude/commands/evidence-check.md`
- Worker steps (screen recording): `docs/evidence/agent-screen-recording.md`
- Extended testing norms (other products): `.claude/skills/evidence-standards.md` (fork-specific PR rules are authoritative in `CLAUDE.md`)
