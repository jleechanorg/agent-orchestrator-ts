# CLAUDE fork reference — Agent Orchestrator

Appendix for long workflows (skeptic verification, PR/CR, evidence, tests, reactions, worktrees). Read root `CLAUDE.md` first.

**Claude Code context compaction** (thresholds, MCP overhead, version strategy, upstream issues, beads bd-cx01–bd-cx05 / bd-tl9t): [context-compaction-optimization.md](context-compaction-optimization.md).

## Skeptic Change Verification Protocol

Before opening any skeptic-related PR, verify the full chain end-to-end locally. Skeptic infrastructure spans CLI code, GHA YAML, lifecycle-worker, and GitHub API — changes in one layer silently break others. Isolated unit tests pass while the integration chain fails (10+ broken PRs in 24h were caught this way).

### Pre-PR Verification Checklist

1. **Full-chain local test**: trigger comment → lifecycle-worker detection → `ao skeptic verify` execution → VERDICT comment posting → `skeptic-gate.yml` polling match.
2. **Cross-layer consistency**: CLI code change? Verify GHA YAML jq filter matches CLI output format. GHA YAML change? Verify CLI output format matches jq filter. Bot author change? Verify the jq filter in `skeptic-gate.yml` (line ~235) accepts the posting identity. Note: `SKEPTIC_BOT_AUTHOR` defaults differ by design — `skeptic-cron.yml` uses `'jleechan2015'` (lifecycle-worker posts as local user), `skeptic-gate.yml` polling uses `'github-actions[bot]'` (GHA runner posts as GHA bot); the jq filter accepts both to cover both paths.
3. **Minimum smoke test**: `ao skeptic verify -n <PR> --dry-run` must output a VERDICT line matching the GHA jq filter pattern. The jq filter in `skeptic-gate.yml` uses `grep -qi "VERDICT: PASS"` / `grep -qi "VERDICT: FAIL"` / `grep -qi "VERDICT: SKIPPED"` — extra text after the keyword (e.g., `VERDICT: FAIL — claude: error`) is accepted; the filter requires the keyword to be present, not a specific format.
4. **Test GHA jq filters against real API output**: When changing jq filters in GHA workflows, test the filter against real API output before merging. Example: `gh api repos/.../commits/{sha}/check-runs | jq '...'` and verify it returns the expected count. This catches bugs where the filter assumes the wrong top-level shape (for example, treating an object like an array, or treating paginated output as a single document instead of slurped pages with `jq -s` when appropriate).

### Red flags — STOP if you see these in a skeptic PR:
- Unit tests pass but no end-to-end chain verification documented
- jq filter in `skeptic-gate.yml` does not match CLI VERDICT output format
- jq filter in `skeptic-gate.yml` does not account for the posting identity used by `ao skeptic verify` (either `'github-actions[bot]'` or `'jleechan2015'` — both are valid by design)
- GHA YAML filters changed without verifying CLI output format, or vice versa

## LLM Evaluation — Shared Utility

**All LLM evaluation (skeptic, verifier, exit-criteria checks) MUST route through `packages/cli/src/lib/llm-eval.ts`.** Never hard-code binary paths (`codex`, `claude`) or `execSync`/`execFileSync` calls in command handlers.

**Re-use chain:**
- `llmEval(prompt, {model?})` → full fallback chain (Codex primary → Claude fallback)
- `tryCodexPrint(prompt)` → codex `exec -` only (prompt via stdin)
- `tryClaudePrint(prompt)` → claude `--dangerously-skip-permissions --print` only (stdin-pipe)
- `resolveCodexBinary()` is imported from `@jleechanorg/ao-plugin-agent-codex` — do not re-implement path detection

**Why:** `llm-eval.ts` centralizes timeout, error classification (ENOENT vs real failure), fail-closed VERDICT parsing, and cross-platform binary resolution. Scattering `execSync("codex ...")` strings across command handlers causes inconsistent error handling and hard-to-find bugs.

## What "Config" Covers

The yaml config is richer than it looks. Before coding, check:

```yaml
reactions:          # Handle any lifecycle event (ci-failed, changes-requested, agent-stuck…)
agentRules:         # Inject instructions into every agent's system prompt
notificationRouting: # Route urgent/action/warning/info to specific notifiers
defaults:           # Global runtime, agent, workspace, notifiers
projects.*:         # Per-project overrides for all of the above
plugins:            # Plugin credentials and settings
```


## Zero-touch metric source of truth

Canonical metric definitions live in `docs/zero-touch-by-operator.md`.

When changing zero-touch semantics (including smoothness), update in lockstep:
- `docs/zero-touch-by-operator.md` (definition + formulas)
- `README.md` pointer section
- `AGENTS.md` / `CLAUDE.md` policy pointers
- Monitor/reporting scripts that compute the metric

Current smooth requirement:
- A PR is zero-touch smooth only if it is zero-touch-by-operator and has
  `max_inactivity_gap <= 60 minutes` across PR-open -> merge timeline events.

## Definition of a "Green" PR (7-Green)

A PR is green when **ALL SEVEN** are true:

1. **CI green** — all required GitHub Actions checks pass (no failures, no pending required)
2. **No merge conflicts** — `mergeable: MERGEABLE` (not CONFLICTING)
3. **CodeRabbit approved** — latest verdict is APPROVE or LGTM (REQUEST_CHANGES is a blocker)
4. **Cursor Bugbot finished** — conclusion neutral/success, no blocking findings
5. **All inline comments resolved** — EVEN after CR APPROVED, check ALL reviewers (CR, Copilot, Bugbot, humans). Major/Critical/actionable are blockers, nitpicks are OK. PRIMARY (GraphQL): `gh api graphql -f query='...'` to get unresolved thread count. FALLBACK (REST — use when GraphQL rate-limited): `gh api repos/OWNER/REPO/pulls/NUM/comments --jq '[.[] | {user: .user.login, body: .body[0:200], path: .path}]'` — review each comment, fix actionable ones.
6. **Evidence review passed** — run `/er` if PR has evidence bundle (skip if none)
7. **Skeptic PASS** — `Skeptic Gate` CI check must pass. Skeptic is an independent LLM verifier that checks all 7 conditions; if it finds a gap, it fails. If `ANTHROPIC_API_KEY` is not configured, the check SKIPs (not a blocker) but a real skeptic run is required for a genuine green PR.

**Never declare a PR green or ask for merge unless all 7 are true.**

**PR status check — always check merge state FIRST:**
```bash
# STEP 0 — mandatory first check. If merged/closed, stop.
gh api repos/OWNER/REPO/pulls/N --jq '{state, merged}'
```
`mergeable_state` returns `unknown` for merged PRs. Review states don't change after merge. Omitting this check causes monitoring loops to report "blocked" on merged PRs.

**After pushing to a branch: EXIT immediately.** Do not sleep-poll for CI or bot results — the monitoring loop handles rechecks. If a bash command times out mid-sleep, do not retry; exit and report current status.

### Pre-push merge-conflict check (MUST do before every push)
The `merge-conflicts` reaction is **reactive only** — it fires after push when the lifecycle-manager next polls. A push to a branch with merge conflicts will show `mergeableState: dirty` immediately but the reaction won't catch it until the next poll cycle. **You must check before pushing:**

```bash
gh pr view --json mergeableState --jq '.mergeableState'
# MUST be "MERGEABLE" or "unstable" (CI running) before pushing.
# "dirty" = merge conflicts — rebase origin/main first.
# "blocked" = branch protection required checks not passing — wait.
```
**NEVER push to a PR that is `dirty` (merge conflicts).** Rebase on origin/main first, resolve conflicts, then push.

### CONFLICTING PRs — P0 Priority
When a PR has `mergeable_state: dirty` (merge conflicts), this is **P0 immediate** — conflicts block all other work on that PR. Do not wait for CI, CR, or any other gate on a dirty PR. Resolve conflicts immediately:

1. **Check current branch**: `git branch --show-current` (must be on main before any worktree operation)
2. **Create/fetch worktree**: `git worktree add ~/.worktrees/pr-N -b fix/PR-N origin/main`
3. **Rebase**: `git rebase origin/main`
4. **Resolve conflicts**, push, repeat until clean
5. **Then** check other gates (CI, CR, etc.)

### CR CHANGES_REQUESTED resolution workflow
When CR posts CHANGES_REQUESTED on your PR:
1. Run `scripts/extract-unresolved-comments.sh <OWNER>/<REPO> <PR>` — gets prioritized list (Critical first)
2. Fix **only those exact items** — no other changes
3. Commit with `[agento]` prefix and push
4. Run `scripts/cr-loop-guard.sh <OWNER>/<REPO> <PR> fix-mode`:
   - Output starts with `cr-trigger` → post `@coderabbitai all good?`
   - Output starts with `copilot-expanded` → run `/copilot-expanded` on the exact comment list
   - Output starts with `skip` → loop limit reached, escalate
5. Wait for CR formal review (not just `<!-- Review triggered -->` acknowledgment)
6. If CR gets stuck in incremental mode (no new formal review after 2 cycles), dismiss the stale review: get latest CR review ID, `gh api repos/<OWNER>/<REPO>/pulls/<PR>/reviews/<ID>/dismissals --method PUT -f message="Stale CR verdict — all comments addressed, dismissing to allow fresh re-review" -f event=DISMISS`, then post `@coderabbitai all good?`

### Skeptic SKIPPED — do not merge
If skeptic posts `VERDICT: SKIPPED` (infra unavailable — no LLM API keys in GHA), the PR does **NOT** have a genuine skeptic review. The `skeptic-cron.yml` workflow handles skeptic evaluation via AO worker. **Do not merge until skeptic-cron has run `ao skeptic verify` and posted `VERDICT: PASS` or `VERDICT: FAIL`.** Check skeptic-cron hasn't already evaluated this PR SHA (comments show `VERDICT:`).

### Skeptic FAIL — hard merge block (even for admins)
A `VERDICT: FAIL` is a hard block. **Never merge a PR that has an unaddressed FAIL verdict**, even as admin. If you see a merged PR with a FAIL verdict in a review, flag it as a gate enforcement gap:
```bash
# Verify Skeptic Gate is in required status checks (it must be):
gh api repos/jleechanorg/agent-orchestrator/branches/main/protection --jq '.required_status_checks.contexts'
# Expected: includes "Skeptic Gate"
# If missing: this is bd-8khr — add it to branch protection
```

### Adding new CI gates — branch protection checklist
When adding a new required CI gate (e.g., a new workflow check):
1. Verify the gate name matches exactly: `gh api repos/jleechanorg/agent-orchestrator/branches/main/protection --jq '.required_status_checks.contexts'`
2. Add the gate name to required status checks via repo Settings → Branches → Branch protection rules
3. Confirm with: `gh api repos/jleechanorg/agent-orchestrator/branches/main/protection --jq '.required_status_checks.contexts'` includes your gate
4. Without step 2, any FAIL verdict can be bypassed by admin merge

### Churn detector — same-file threshold
The 3-PR churn threshold applies to subsystem keywords. For **same file** fixes, the threshold is **2**: if 2 PRs touching the same file have merged within 4 hours, stop and add an integration test before opening another.
```bash
# Before opening a PR, check recently merged PRs for file overlap:
# Cross-platform date fallback: macOS/BSD `date -v` sets relative time, GNU/Linux `date -d`
# does the same. The first invocation uses macOS syntax and redirects stderr to /dev/null so
# it silently falls through to the GNU/Linux fallback on non-macOS systems.
gh pr list --repo jleechanorg/agent-orchestrator --state merged \
  --search "merged:>=$(date -v-4h +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -d '4 hours ago' +%Y-%m-%dT%H:%M:%SZ)" \
  --json number,title,files 2>/dev/null | jq '.[] | {number, title, files}'
# If any recently merged PR touches the same file as your change → churn protocol
```

### Evidence philosophy — agent claims require proof artifacts
- **Claims without artifacts are insufficient.** Treat implementation claims (behavior, fixes, UX) as **unproven** unless tied to **human-verifiable** artifacts in `## Evidence`.
- **Substantive work** (features, meaningful refactors, non-trivial behavior changes) requires a **reproducible evidence bundle** every time — not narrative-only summaries.
- **UI / interactive changes:** Prefer **video** of key flows; include **before** and **after** screenshots for critical visual deltas (same framing when comparing). CI still enforces **UI media** (or exact `N/A - no UI changes`); reviewers use `docs/evidence/reviewer-checklist.md` for bar-raising on UI proof.
- **Command logs + mapping:** Fenced **terminal test output** must support repeats; add a short **Claim → artifact map** (bullets) when multiple claims need separate proof.
- **Self-validation:** Verify in an **isolated** context when practical (clean worktree / documented env). Exercise **negative / error paths** where risk warrants it. **Revert** temporary debug toggles or test-only hacks before finalizing.
- **Goal:** Evidence that maximizes **fast human review** and **merge confidence** — scannable, repeatable, honest about limits.

### Evidence Bundle v2 (mandatory): reproducible gist + terminal media + terminal test logs + UI
Evidence is fail-closed: every PR must include a self-contained bundle in `## Evidence`. CI enforces this in both `wholesome.yml` (**Evidence Has Media Attachment**) and `evidence-gate.yml` (**Evidence Gate**). **Policy depth** (philosophy, reviewer checklist, `/er` guidance): `docs/evidence/README.md`.

Hard requirements (all must be true):
1. **Repro gist** — `**Repro gist**: https://gist.github.com/...` (clone-and-run capable).
2. **Terminal media** — **Mandatory on every PR**: captioned HTTPS screenshot or video (`**Terminal media**:`) that clearly shows **tmux or terminal** context (caption must mention `tmux` or `terminal` **outside** the label line — see workflow `TM_FOR_CTX` stripping). Image-only or code-only substitutes are **not** accepted.
3. **Terminal test output** — **Mandatory in addition to** terminal media (not either/or): `**Terminal test output**:` followed by a fenced code block with real test run logs (must reference a concrete test command such as `pnpm`/`npm`/`vitest`/… `test`).
4. **UI media** — For UI changes: captioned HTTPS screenshot or video under `**UI media**:` (multiple images or a video link are fine for before/after). If there are **no UI changes**, use **exactly** this text (including spacing): `N/A - no UI changes` (may appear in the `**UI media**:` line or elsewhere in `## Evidence`).

Recommended (strongly for reviewers + `/er`):
- **`**Claim → artifact map**:`** — Bullets mapping each major PR claim → gist step / log / media.
- **UI-rich PRs:** Video + before/after stills per `docs/evidence/reviewer-checklist.md`.

Rules:
- Before first push: run `/pr-media` (or equivalent) and capture real tmux/terminal media plus fenced test logs.
- Repro gist must contain exact steps to clone the PR branch, install deps, run tests, and reproduce the claimed result.
- Placeholder evidence (`<path>`, `<value>`, `TODO`, `TBD`, `example.com`) is forbidden and fails CI.
- `simulated` output is forbidden — only real command output.
- Evidence checks are pre-merge only; merged/closed PRs are skipped.

### Evidence review (`/er`) vs CI vs Skeptic
- **`/er` (step 6 of 7-green):** Human or agent review that evidence **substance** matches the **claimed** class. Use when the PR has an evidence bundle; **PASS/INSUFFICIENT** is about proof fit, not YAML shape alone.
- **Evidence Gate (CI):** Format and presence rules only; fails closed on missing fields.
- **Skeptic Gate:** Independent LLM check on overall merge readiness (can flag gaps between claims and 7-green story). Does not replace real artifacts or `/er`.

### Cursor cloud-agent artifact model (reference)
Cursor describes **cloud agents** that run in isolated environments, **test their changes**, and **produce artifacts (videos, screenshots, and logs)** so reviewers can validate work quickly, and open **merge-ready PRs with artifacts to demo their changes**. See [Cursor agents can now control their own computers](https://cursor.com/blog/agent-computer-use) (product announcement; read the full post for examples). The same post shows **video artifacts** for full flows, **screenshots** for static proof, and **summaries/logs** alongside — not prose-only claims.

Evidence Bundle v2 mirrors that intent for AO workers: **Terminal media** = screenshot or video of tmux/terminal (visual proof), **Terminal test output** = real command logs, **Repro gist** = clone-and-run reproducibility, **UI media** = user-visible change proof or explicit N/A. Prefer **direct HTTPS links** to viewable images or videos (e.g. GitHub PR/user-attachments, or markdown `![alt](https://...)`), not a bare gist page URL as a substitute for terminal screenshot/video.

For long-running agent observability, Cursor's research on scaling autonomous coding emphasizes logging **agent messages, system actions, and command outputs, with timestamps** for replay and review — see [Towards self-driving codebases](https://cursor.com/blog/self-driving-codebases). The fenced **Terminal test output** block is the PR-level analogue: concrete command output a reviewer can grep, alongside visual terminal media.

### Evidence Gate strong proof — run `/pr-media` BEFORE first push
The **Evidence Bundle v2** above is the canonical format. For non-unit claims (`integration`, `pipeline-e2e`, `pr-lifecycle-e2e`, `merge-gate`), CI also enforces these minimum strong-proof requirements:
1. media artifact URL (screenshot/video — HTTPS, extension-suffixed or markdown image)
2. execution artifact (a fenced code block with triple backticks, or a structured `**Terminal test output**:` line)
3. self-validation language (`verified`, `confirmed`, `error case`, `reproduced`, etc. — a bare `**Self-validation**:` label is insufficient)

**`docs/evidence/strong-evidence-standard.md`** is the quick-reference template; the Evidence Bundle v2 section above is the authoritative policy.
- Before first push: run `/pr-media` to capture screenshot/video and include real test/terminal output
- If `/pr-media` is unavailable: include HTTPS media URL from another capture path plus real command output
- Placeholder text (`<value>`, `<path>`, `<screenshot path>`, `TODO`, `TBD`) and `simulated` output fail the gate

## Fork Isolation — Code Separation from Upstream

This fork diverges from `ComposioHQ/agent-orchestrator`. To minimize merge conflicts and preserve cherry-pick ability:

### Rules

1. **New features go in new files** — never add fork logic inline to upstream files. Create a separate module and import it.
2. **Extend, don't modify** — if you must touch an upstream file (types.ts, config.ts, lifecycle-manager.ts), prefer additive-only changes (new union members, new interface fields, new exports). Exception: extracting existing fork logic *out* of upstream files into companion modules is encouraged — it reduces the upstream diff even though it restructures the file.
3. **Plugin-first** — use the plugin system (agent, runtime, scm, notifier, poller, workspace) for new capabilities. Plugins are entirely isolated by design.
4. **Keep core diff minimal** — `packages/core/src/` files should have the smallest possible diff against upstream. Extract fork logic into `*-extensions.ts` or `fork-*.ts` companion files.
5. **Re-exports over inline** — when adding exports to `index.ts`, group fork-specific exports together at the bottom with a comment marker.

### High-Conflict Files (minimize changes)

| File | Why it's risky |
|------|---------------|
| `lifecycle-manager.ts` | Core polling loop; upstream actively develops this |
| `types.ts` | Shared type definitions; union extensions add lines near upstream changes |
| `config.ts` | Zod schemas; upstream adds fields here too |
| `spawn.ts` | CLI entry point; upstream refactors argument parsing |

### Safe Files (no conflict risk)

- Everything in `packages/plugins/` — entirely new packages
- `roadmap/`, `.beads/`, `docs/design/` — fork-only documentation
- New `packages/core/src/*.ts` files — net new, no upstream equivalent

## Test Classification — Mandatory Naming and Content Rules

**These rules are enforced. Violations are trust violations.**

### File naming determines test tier

| File pattern | Tier | Requirements |
|---|---|---|
| `*_e2e_*` or `*_e2e.py` or `*e2e*` | **E2E** | Must meet ALL criteria below |
| `*_integration_*` | **Integration** | Real I/O, real APIs, but may skip full pipeline |
| `*_test_*` or `test_*` (default) | **Unit** | May use mocks, stubs, fakes |

### E2E test mandatory criteria
A test file named with "e2e" MUST satisfy ALL of these. If ANY is false, rename it to `*_integration_*` or `*_smoke_*`:

1. **Spawns real external work** — e.g., `ao spawn` a session that actually runs, `gh pr create`, etc.
2. **Waits for that work to complete** — not spawned and immediately killed. The external process must do real work (push code, run CI, etc.).
3. **Verifies an outcome that only exists if the full pipeline ran** — e.g., a PR was created, CI passed, a merge happened.
4. **Creates its own test data** — does not rely on pre-existing PRs, sessions, or resources.
5. **Takes >60 seconds** — if it completes in under a minute, it's not E2E.

### What is NOT an E2E test
- Importing a module and checking it's callable → **unit test**
- Writing to a temp file and reading it back → **unit test**
- Calling a real API to check status of a pre-existing resource → **integration test**
- Spawning a session and immediately killing it → **smoke test**
- Constructing an event in Python and routing it → **integration test**

### Before committing any test with "e2e" in the name
Ask: "If I showed this to the user and said 'the E2E test passes', would they agree this proves the system works end-to-end?" If there's any doubt, use a more honest name.

### Evidence claim-class matrix — fail-closed verdicts (bd-7ay)

When reviewing or producing evidence, identify the **claim class** before issuing a verdict. Verdict is **INSUFFICIENT** (not PASS) if required proofs for the claimed class are missing.

| Claim class | Required proofs |
|---|---|
| **Unit test coverage** | Test file path, pass/fail counts, coverage % |
| **Integration test** | Test log with real I/O, API calls shown, timing |
| **Pipeline E2E** | Session spawn proof, event routing proof, outcome recording proof |
| **PR-lifecycle E2E** | PR creation (URL+timestamp+actor), transition proof (CI/review timeline), merge outcome, cleanup proof |
| **Merge-gate green** | All conditions checked with evidence per condition |

**Fail-closed rules:** PASS only if ALL required proofs are present. INSUFFICIENT if any missing. Never downgrade the claim class to avoid INSUFFICIENT. A pipeline E2E does NOT satisfy a PR-lifecycle E2E claim.

## Reaction Action Idempotency

The reaction system (`lifecycle-manager.ts`) fires actions when a lifecycle condition holds (see `executeReaction`). Supported action types: `notify`, `auto-merge`, `send-to-agent`, `respawn-for-review`. Actions MUST be designed for repeated execution:

| Action type | Idempotent? | Guard required |
|---|---|---|
| `notify` | Yes (duplicate notifications are cheap) | None |
| `auto-merge` | Yes (GitHub ignores duplicate merge attempts) | None |
| `send-to-agent` | **NO** — each send consumes agent context window | `retries` cap + SHA dedup |
| `respawn-for-review` | **NO** — creates duplicate sessions | Session existence check |

`escalate` is an internal outcome (reaction stops and emits `reaction.escalated` event) — it is not a configured action type.

**Rules for non-idempotent actions:**
1. Always set `retries: 2-3` in the reaction config — never rely on the default (`Infinity` for non-send-to-agent actions)
2. Use `escalateAfter` to cap total time, not just retry count
3. When adding new action types, classify idempotency FIRST. If non-idempotent, add dedup logic to `executeReaction()` before shipping.
4. The `ReactionTracker` currently tracks `attempts` only. SHA-based dedup (`lastSentHeadSha`) is being added (bd-n039). Until then, config-level `retries` is the primary guard.

## Pre-spawn capacity check

Before dispatching AO workers:

1. Run `gh api rate_limit` and inspect budgets.
2. Count active tmux sessions: `tmux list-sessions | wc -l`.
3. Spawn gate:
   - If active tmux sessions > 20, do **not** spawn new AO workers; warn the user instead.

When blocked by this gate, include current counts and the exact blocker in your status update.

### GraphQL exhausted — REST worktree path (still spawns an AO worker)

`ao spawn --claim-pr N` uses GraphQL. When GraphQL quota is 0, **still dispatch an AO worker** — just create the worktree via REST instead:

1. **Create worktree + branch manually** (REST / no GraphQL needed):
   ```bash
   cd /Users/jleechan/project_agento/agent-orchestrator
   git worktree add ~/.worktrees/manual-<task> -b feat/<bead-id> origin/main
   ```
2. **Spawn the AO worker in tmux** (this IS the AO worker — not a CLI fallback):
   ```bash
   tmux new-session -d -s <session-name> "cd ~/.worktrees/manual-<task> && claude --dangerously-skip-permissions"
   ```
   This is still an AO worker — it runs in tmux, can receive work, push code, and open PRs. The only difference is the worktree was created via REST instead of `ao spawn`.

3. **Check PR metadata via REST** (always works): `gh api repos/OWNER/REPO/pulls/N --jq '{branch: .head.ref, state: .state}'`
4. **Create PRs via REST**: `gh api repos/OWNER/REPO/pulls --method POST -f title="..." -f head="BRANCH" -f base="main" -f body="..."`
5. **REST quota**: typically 3000-5000/hr — use `gh api rate_limit --jq '.resources.core.remaining'`
6. **Lifecycle-worker auto-backfill**: workers with `backfillAllPRs: true` will adopt the PR once GraphQL resets (~1h)

**Never fall back to "just run `claude -p` and do it yourself."** The AO worker in tmux is always preferred over direct CLI execution.

### `GITHUB_TOKEN` auth — verify first, unset only if broken

Do NOT `unset GITHUB_TOKEN` by default. First run `gh auth status` to check if auth is healthy.
Only unset temporarily when auth is broken/stale:

```bash
gh auth status                         # check if auth works
# Only if auth is broken:
unset GITHUB_TOKEN && gh auth status   # confirm real auth
```

## Worktree protection — ABSOLUTE RULE

**NEVER run `git worktree remove` or `git worktree prune` in an interactive agent session.** Only a human running manually in a terminal, or the automated `lifecycle-worker` (which uses the AO session DB + tmux liveness as a fail-safe), is permitted to remove AO worktrees. A hook (`.claude/hooks/protect-worktrees.sh`) blocks these at the tool level for interactive sessions.

**Hook registration**: The hook is a PreToolUse hook registered in `~/.claude/settings.json` (user-scope). For new agent sessions spawned by AO, the `agent-claude-code` plugin writes a settings file — to ensure the hook runs in spawned sessions, add the hook path to that settings file or document it in onboarding. The hook file is committed to this repo at `.claude/hooks/protect-worktrees.sh` for reference and distribution.

When writing worktree-cleanup scripts, scope ONLY to AO session names:
```bash
# REQUIRED guard at top of any worktree loop
if [[ ! "$session_name" =~ ^(ao|jc|wa|cc|ra|wc)-[0-9]+$ ]]; then
  echo "SKIP (non-session worktree): $session_name"
  continue
fi
```
Worktrees named `worktree_worker*`, `worktree_pr*`, `worktree_agentog*` etc. are Claude Code session directories — removing them kills the agent session.

## Coding Standards

- TDD: write the failing test first, then implement
- TypeScript strict: no `any`, no `// @ts-ignore`
- Conventional commits: `feat:`, `fix:`, `chore:`, `docs:`, `test:`
- Never push to main — always open a PR
- Closing a PR is allowed ONLY when it is superseded by another PR. Before closing: (1) verify ALL changes from the closed PR are present in the superseding PR, (2) post a comment "Superseded by #NNN — all changes verified covered." If a PR has conflicts, rebase it — don't close it.
- Force-push your own PR branches with `--force-with-lease` when rebasing. Never force-push main.
- Never `git add -A` — stage only files you changed
- Files under ~300 LOC; split for clarity

## Running Tests

```bash
pnpm --filter @composio/ao-core test        # core package only
pnpm test                                   # all packages
```

## This Is an Independent Fork

This repo is `jleechanorg/agent-orchestrator`. It started as a fork of `ComposioHQ/agent-orchestrator` but is now developed independently. Upstream sync is not a goal.

- All PRs target `jleechanorg/agent-orchestrator`
- `roadmap/` docs are tracked and welcomed — they are the design record for this fork
- `.beads/issues.jsonl` is the issue tracker — commit it when beads are opened or closed
- Remote `jleechanorg` points to the fork; `origin` points to upstream (read-only)
- **Upstream-strip rule**: When preparing PRs to `ComposioHQ/agent-orchestrator`, remove all fork-only artifacts. Explicitly exclude: `CLAUDE.md`, `AGENTS.md`, `roadmap/`, `.beads/`, `docs/design/*.md`, and any commits referencing fork-specific infra (openclaw, jleechanorg-specific tooling).

## PR Target — CRITICAL SAFETY RULE

**NEVER open a PR against `ComposioHQ/agent-orchestrator` without explicit in-thread approval from jleechan.**

Before creating any PR, confirm the target repo. If the target is `ComposioHQ/agent-orchestrator`, stop and ask:
> "This would open a PR against the ComposioHQ upstream. Do you approve?"

Default target is always `jleechanorg/agent-orchestrator`. When approved, strip fork-only artifacts: `CLAUDE.md`, `AGENTS.md`, `roadmap/`, `.beads/`, `docs/design/*.md`, and commits referencing fork infrastructure.

## Upstreaming to ComposioHQ — What to Strip

When cherry-picking work to a `feat/*-upstream` branch for a ComposioHQ PR, **do not include**:

- `docs/design/*.md` — fork-only markdown design docs (HTML equivalents are fine)
- `CLAUDE.md` — fork-specific Claude Code instructions
- `AGENTS.md` — fork-specific agent/contributor guidelines
- `roadmap/` — fork roadmap docs
- `.beads/` — local issue tracker
- Any commit that references fork infrastructure (openclaw, jleechanorg-specific tooling)

## Bulk PR Merging

Use `/bulk-merge` to evaluate, risk-assess, and sequentially merge multiple PRs. See `.claude/commands/bulk-merge.md` for the full workflow. Key points:

- Verify all 4 green checks before merging any PR
- Merge low-risk (additive-only) PRs first, smallest to largest
- Medium-risk (modifies existing files) PRs merge after low-risk
- Resolve `index.ts` and `.beads/issues.jsonl` conflicts between each merge (keep both sides)
- Run `pnpm build && pnpm test && pnpm typecheck` after all merges complete

## Mirror Fork for Clean Upstream PRs

There is a separate mirror fork at `jleechan2015/agent-orchestrator-mirror` that mirrors `ComposioHQ/agent-orchestrator` exactly. Use this for submitting PRs that should go upstream without custom fork logic:

- **Location**: `~/projects_reference/agent-orchestrator-mirror`
- **Purpose**: Submit Cursor/Gemini CLI support to upstream without MCP mail or other custom changes
- **Workflow**:
  1. Sync mirror to `ComposioHQ/agent-orchestrator` main
  2. Copy desired plugins (agent-cursor, agent-gemini, agent-base) from this fork
  3. Remove any custom logic (MCP mail, etc.)
  4. Push and create PR against the mirror, not upstream

**Current mirror PR**: https://github.com/jleechan2015/agent-orchestrator-mirror/pull/1

This fork's work will be proposed to ComposioHQ separately from this repo's custom development.

## Main Repo Branch Invariant

The main repo at `/Users/jleechan/project_agento/agent-orchestrator` **MUST stay on `main`**.

AO agents work in git worktrees (`~/.worktrees/`), never directly in the main clone.

**If you find the main repo on a feature branch:**
```bash
git -C /Users/jleechan/project_agento/agent-orchestrator checkout main
git -C /Users/jleechan/project_agento/agent-orchestrator pull --ff-only
```

**Before diagnosing `lifecycle.backfill.claim_failed` errors, always verify:**
```bash
git -C /Users/jleechan/project_agento/agent-orchestrator branch --show-current
# Must print "main"
```

A feature branch checked out in the main repo blocks ALL `git fetch --force` operations for any PR on that same branch, causing cascading `claim_failed` aborts in `backfillUncoveredPRs`.

## Lifecycle Backfill Claim Failure — Triage Checklist

When seeing `lifecycle.backfill.claim_failed` with "refusing to fetch into branch", check IN ORDER:

1. **Main repo on wrong branch?** `git -C <repoPath> branch --show-current` — fix: `git checkout main`
2. **Ghost worktrees?** `git worktree list | grep -E '^-.*-(ao|jc|wa|cc|ra|wc)-[0-9]+ '` — fix: `git worktree remove --force <path>`
3. **Both?** Fix main repo first, then ghost worktrees.

The lifecycle-worker's `sweepOrphanWorktrees` runs every 5 minutes (orphanSweepIntervalMs) and auto-cleans ghost worktrees immediately when both conditions hold: (1) no entry in the AO session DB, and (2) no live tmux session for that worktree's short ID. There is no TTL — cleanup is eager once both guards confirm orphan state. If you see claim failures, check the main repo branch first.

## AO Infrastructure Operations

### Config path and data namespace

AO uses `SHA256(dirname(configPath))` to create isolated data directories under `~/.agent-orchestrator/{hash}-{projectId}/`. The hash is derived from the **directory containing `agent-orchestrator.yaml`**, not the file itself.

**Canonical staging config**: `~/.openclaw/agent-orchestrator.yaml` (editable)

**Canonical production config**: `~/.openclaw_prod/agent-orchestrator.yaml` (promoted only after validation)

**NEVER symlink staging onto production** and **NEVER create a second unmanaged `agent-orchestrator.yaml`** in another directory. Running `ao` from a directory that contains its own `agent-orchestrator.yaml` creates a shadow namespace — sessions, PID files, and logs go to a different data dir, invisible to the lifecycle-worker.

### Decommissioning an AO config path or project directory

Before deleting any directory that contains (or contained) `agent-orchestrator.yaml`:

1. **Kill all tmux sessions** using that namespace: `tmux list-sessions | grep <prefix>` then `tmux kill-session -t <name>`
2. **Kill the lifecycle-worker** for that namespace: check PID files in `~/.agent-orchestrator/*-agent-orchestrator/lifecycle-worker.pid`
3. **Kill the orchestrator session** if running: `tmux kill-session -t *-ao-orchestrator`
4. **Then delete** the directory
5. **Verify** no processes remain: `ps aux | grep lifecycle-worker.*agent-orchestrator`

### Monitoring worker sessions

Use the `ao-session-monitor` skill (`~/.claude/skills/ao-session-monitor.md`) when checking if AO worker tmux sessions are active.

**Critical**: Claude Code renders `❯` at the bottom while thinking above it. Checking only 5–6 lines gives **false idle reports**. Always capture 20+ lines and look for Unicode activity indicators (`✻✶✳✽✾`).

## PR Worker Coverage — Harness Safeguards (bd-7ay)

AO workers drive this repo's PR lifecycle. Coverage repair must be **deterministic and fail-closed**. The following rules apply whenever a session is dispatched to repair uncovered or inactive PR workers.

### Mandatory recovery command

When a user asks about uncovered or inactive PR workers, dispatch an AO worker per uncovered PR:

```bash
# One session per uncovered PR
ao spawn --project agent-orchestrator --claim-pr <PR_NUMBER>
```

**AO workers are the tool — not a last resort.** Do NOT use `bd open`, bead spawn, or direct CLI (`claude -p`) for coverage repair. An AO worker in tmux with the worktree already set up is always the right answer.

### PR Coverage Reconciliation Procedure

To reconcile PR coverage (compute uncovered PRs, map active sessions, dispatch repair sessions, verify):

1. **List open PRs** in the repo:
   ```bash
   gh pr list --repo jleechanorg/agent-orchestrator --state open --limit 100 --json number,title,headRefName
   ```
2. **List active AO sessions** (with EPIPE guard):
   ```bash
   ao session ls --project agent-orchestrator 2>/dev/null || echo "EPIPE: session list unavailable"
   ```
3. **Cross-reference**: for each open PR, check if there is a session actively working on it (check branch name or linked PR in session status).
4. **Dispatch repair sessions** for any uncovered PRs using the mandatory command above.
5. **Validate coverage** using `scripts/check-pr-worker-coverage.sh`.

### Validation script

`scripts/check-pr-worker-coverage.sh` reports PR→session mapping and **exits non-zero** if uncovered PRs remain after coverage-repair mode. Run it after any coverage repair operation to confirm deterministic mapping:

```bash
./scripts/check-pr-worker-coverage.sh
echo $?  # 0 = all PRs covered, non-zero = uncovered PRs remain
```

### EPIPE handling in reporting paths

When `ao session ls` is used in automated reporting (cron, hooks, scripts), wrap it with EPIPE guards:

```bash
# Bad: EPIPE from closed pipe kills the script
ao session ls --project agent-orchestrator | grep working

# Good: EPIPE guard prevents script failure
ao session ls --project agent-orchestrator 2>/dev/null | grep working || true
```

Common EPIPE sources in the AO reporting path: `ao session ls` piped to `head`, `grep`, or `wc` when the consumer exits before the pipe buffer is consumed. The `--project` flag also avoids namespace shadowing when `ao` is run from a directory containing a shadowing `agent-orchestrator.yaml`.
