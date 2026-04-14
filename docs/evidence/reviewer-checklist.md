# Reviewer artifact checklist (practical)

Use this for **`/er`**, CodeRabbit follow-ups, or human review. **Fail closed**: if a required row is missing for the **claimed** work type, verdict is **INSUFFICIENT** (not PASS).

## A. Every substantive implementation PR

| Check | Pass criteria |
|--------|----------------|
| **Evidence section** | `## Evidence` present; **Claim class** matches actual work; **Verdict** stated |
| **Repro gist** | HTTPS gist with steps to fetch branch, install, run tests / repro |
| **Terminal media** | Screenshot or **video** URL + caption; caption shows **tmux or terminal** context (not satisfied by the label alone) |
| **Terminal test output** | Fenced logs **in addition to** media; shows real command(s) (e.g. `pnpm`/`vitest`/…) |
| **Claim → artifact** | For each major claim in the PR description, you can point to **gist step**, **log line**, or **media** — add a short **Claim → artifact map** bullet list in Evidence if crowded |
| **No placeholders** | No `TODO`, `<path>`, `example.com`, or `simulated` in Evidence |
| **Self-validation** | Evidence reflects **final** branch state; no leftover debug-only toggles described as “temporary” without revert |

## B. UI / interactive changes

| Check | Pass criteria |
|--------|----------------|
| **UI proof** | **Video MANDATORY** (.mp4/.gif) for all primary flows; screenshots alone are INSUFFICIENT for interactive behavior. Show **before** and **after** states. |
| **N/A honesty** | `N/A - no UI changes` only if **no** user-visible or interactive behavior changed |

## C. Risk-sensitive behavior (auth, merge, payments, destructive ops)

| Check | Pass criteria |
|--------|----------------|
| **Negative paths** | Where relevant: log or media showing **error handling** or rejection path (not only happy path) |
| **Isolation** | Note if proof was run in **clean worktree** / CI-like env vs one-off machine state |

## D. Fast merge confidence (reviewer ergonomics)

| Check | Pass criteria |
|--------|----------------|
| **Top-load** | First screen of Evidence answers: what, how to repro, where’s the proof |
| **Repeatable** | Gist + commands match **this** PR head; not copied from another branch |

---

**Verdict guidance:** **PASS** only if A (and B/C when applicable) are satisfied for the **claimed** class. Otherwise **INSUFFICIENT** with explicit missing rows.
