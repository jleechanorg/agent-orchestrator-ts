# Upstream Go Migration — Design Synthesis

**Date:** 2026-06-25
**Author:** AO fork integration analysis
**Branch:** `dev1782443415-upstream-go-integration`
**Status:** PROPOSAL — not yet a plan, awaiting operator decision
**Scope:** Strategic options for `jleechanorg/agent-orchestrator` relative to upstream `agentwrapper/agent-orchestrator`'s TS→Go rewrite

---

## TL;DR

Upstream `agentwrapper/agent-orchestrator` has been **fully rewritten in Go** (393 `.go` files, 25 packages, Go 1.25.7, module path `github.com/aoagents/agent-orchestrator/backend`). The TS monorepo is **gone** upstream — only an Electron/React frontend remains. There is **no TS bridge**, **no shared types**, **no shared runtime**. The fork's TS code and upstream's Go code are now **orthogonal codebases**.

**Three viable paths forward:**

| Path | Cost | Risk | Strategic value |
|---|---|---|---|
| **A. Stay TS, ignore upstream** | Low (status quo) | High (orphan tech) | Low — accumulating fork-vs-upstream drift |
| **B. Selective Go port (plugin-by-plugin)** | Medium (~3-6 months) | Medium | High — gets upstream ergonomics where it matters |
| **C. Full fork → Go rewrite** | Very High (6-12 months) | Very High | Very High — future-proof, but kills fork velocity |
| **D. Go default + explicit TS carve-outs** | High (9-12 months) | Medium-High | Very High — best of C with bounded scope via TS islands |

**My recommendation: Path D (Go default + TS carve-outs), starting with the daemon.** Skeptic agent stays TS/tsx per operator decision. Path B is the conservative alternative if operator wants to defer the commitment.

**Path D vs Path C:** C is "rewrite everything in Go." D is "rewrite everything in Go **except** named TS islands." D is bounded — every TS file must justify itself. C is unbounded — every TS file is suspect.

---

## What upstream actually did

### Architecture (verified by subagent)

Upstream Go module layout:

```
backend/
├── main.go                    # Compatibility wrapper → daemon.Run()
├── cmd/
│   ├── ao/main.go            # Cobra CLI entrypoint
│   └── genspec/main.go       # OpenAPI/JSON schema generator
├── sqlc.yaml                  # sqlc config (queries → generated Go)
├── go.mod                     # Go 1.25.7; chi, cobra, goose, sqlc, creack/pty, swaggest
├── api/openapi.yaml           # Generated OpenAPI spec from Go DTOs
├── migrations/                # Goose SQL migrations
├── docs/STATUS.md             # Build instructions: `cd backend && go build ./... && go test -race ./...`
└── internal/
    ├── cli/         (~40 files)  # Cobra `ao` commands
    ├── daemon/                   # Loopback HTTP serve, storage init, CDC, lifecycle, shutdown
    ├── httpd/                    # chi router, CORS, /healthz, /readyz, SSE at /api/v1/events, WS /mux
    ├── storage/sqlite/           # SQLite + goose + sqlc queries + change_log triggers
    ├── cdc/                      # DB triggers → in-process subscribers + SSE
    ├── lifecycle/                # Reducer: runtime/activity/spawn/termination facts + agent nudges
    ├── service/                  # Controller-facing services (project, session, pr, review)
    ├── observe/scm/              # GitHub SCM observer (ETag polling, semantic diffing)
    ├── observe/reaper/           # Runtime liveness loop
    ├── terminal/                 # WebSocket terminal mux (ch-tagged wire protocol)
    ├── adapters/                 # Port adapters: agent/ (23 harnesses), runtime/ (tmux + conpty), workspace/, scm/, tracker/, reviewer/, telemetry/
    ├── ports/                    # Inbound/outbound interfaces (boundary contracts)
    ├── domain/                   # Shared types: sessions, activity, PR facts, API status
    ├── notify/                   # Durable dashboard notifications
    ├── preview/                  # Desktop preview browser
    ├── review/                   # PR review execution
    ├── runfile/                  # running.json registration
    ├── agentlaunch/              # Agent launch spec
    ├── config/                   # Env/default config loader
    ├── legacyimport/             # One-shot importer from old TS state
    ├── integration/              # E2E tests
    └── ... (25 packages total)
```

**Key facts:**

1. **TS is NOT alongside — TS is GONE.** Only 4 TS references in 393 Go files (all binary-path strings in agent adapters, not imports).
2. **Module org discrepancy**: upstream uses `github.com/aoagents/...` for Go module path, but repo org is `agentwrapper`. Different development line.
3. **Storage rewrite**: SQLite + goose + sqlc, replaces fork's `state.json` model. CDC poller + SSE replaces fork's file-based event loop.
4. **HTTP API as the integration seam**: Loopback HTTP daemon exposes `/healthz`, `/readyz`, `/shutdown`, SSE, WebSocket. CLI is now a thin client over loopback HTTP.
5. **Agent adapter proliferation**: 23 agent harnesses (claudecode, codex, cursor, opencode, aider, amp, goose, copilot, grok, qwen, kimi, crush, cline, droid, devin, auggie, continue, kiro, kilocode, autohand, pi, vibe, agy). Fork has ~5 (claude-code, codex, wafer, minimax, opencode).
6. **Runtime abstraction**: tmux on Unix, ConPTY on Windows. Replaces fork's hardcoded tmux.
7. **Frontend unchanged in design**: `frontend/CLAUDE.md` cites the fork's `packages/web/src` as the UI design source — the React/Electron frontend was rebuilt but visually matches the fork's design.

### Commit evidence

Recent commits ADDING `.go` files (all 2026-06-20 or later):

- `f98c5e56` — fix(storage): renumber telemetry migration to 0015 to resolve 0014 version collision (#334)
- `c53c4af8` — test(storage): guard against duplicate goose migration version prefixes (#336)
- `0e1c5fe5` — feat: posthog error tracking redaction (#329)
- `6f8112e` — feat: surface SCM summaries in desktop (#263)
- `c6d9692` — feat(frontend): add live browser panel (#375)
- `7ba8607` — fix: add terminal controls and restore copy/scroll (#372)
- `8fa403c` — fix(preview): add clear, reuse defaults, force refresh, local files (#379)
- `ea54f31` — fix(daemon): fall back to ephemeral port on conflict + harden teardown (#386)
- `47e3ddd` — fix(desktop): stop console-window flashing on Windows (#399)
- `a96143b5` — Zellij to tmux + ConPTY runtime, session save/restore, crash-proof reconcile (#2183)
- `8bbc4c94` — fix: hide backend subprocess windows on Windows (#2179)

The Go project itself is much older than the clone window (depth 50). The fork's only known upstream-tracking PR is #712 (tracks upstream #1186 — TS→TS lifecycle-worker deletion, **not** the Go switch).

---

## Strategic context

### Why upstream went Go (inferred)

1. **Single static binary distribution** — `go build` produces a single binary vs Node 22 + pnpm + monorepo + per-platform binaries.
2. **Loopback HTTP daemon** — solves the "what supervises the supervisor" problem; one persistent daemon serves many CLI invocations.
3. **SQLite + CDC** — durable session/activity state with built-in change notifications (no Redis, no external DB).
4. **Goroutines + channels** — natural fit for the "many concurrent agent sessions" workload.
5. **Cross-platform ConPTY** — Windows support that was painful in TS.
6. **sqlc + goose** — type-safe SQL with explicit migrations, replaces TS's `any`-typed JSON files.

### Why the fork exists at all

The fork `jleechanorg/agent-orchestrator` is the **operator's working copy** with:

- **Plugin-first architecture** (already maps to upstream's `internal/ports/`)
- **Skeptic** (`packages/cli/src/lib/llm-eval-shared.ts`) — multi-model LLM evaluator with fallback chain (Codex → Claude). Operator wants this to **stay TS/tsx**.
- **Webhook registration control** (PR #727 just merged — opt-in, not auto)
- **Fork-only SCM adapters** (`smartclaw` → `jleechanbrain`, `worldarchitect`, etc.)
- **Hooks + lifecycle customization** not in upstream
- **4+ years of operator-specific tuning** (config defaults, notifier routing, 7-Green enforcement, evidence gates)

### The fork's moat

The fork isn't upstream-compatible — it's **operator-tuned**. Upstream is a generic product; the fork is a specific deployment. That's why a 1:1 merge is impossible.

---

## Four paths

**What it means:** Keep developing the TS monorepo. Cherry-pick interesting upstream ideas (architecture, SQL storage) but port them to TS or implement equivalents. Accept accumulating drift.

**Pros:**
- Zero migration cost
- Fork velocity preserved
- Skeptic + custom plugins keep working
- All 700+ existing tests remain green

**Cons:**
- Drift compounds. Upstream will add features (23 agents vs our 5; CDC; WebSocket terminal) that are non-trivial to replicate.
- Operator benefits from upstream's bug fixes only via manual port.
- Hiring/collaboration: contributors who know Go can't easily contribute to TS fork.
- Eventually, fork becomes "an old TS app."

**When this is right:** If operator priorities (skeptic, custom notifiers, evidence gates) dominate over feature parity with upstream.

### Path B — Selective Go port (conservative alternative to Path D)

**What it means:** Port the **daemon + storage + HTTP API layer** to Go, keeping the **TS fork** as the operator UI / plugin host / skeptic. The TS fork's CLI talks to a Go daemon over loopback HTTP — exactly upstream's architecture.

**Phase 1 (months 1-2): Stand up a Go daemon in the fork**
- Vendor `internal/daemon`, `internal/storage/sqlite`, `internal/cdc`, `internal/httpd` from upstream
- Strip fork-specific UI/Skeptic — those stay in TS
- Expose the Go daemon's HTTP API as `ao`'s new backend
- Keep the existing TS `ao` CLI as a fallback during migration

**Phase 2 (months 3-4): Migrate storage**
- Replace `state.json` model with SQLite + goose migrations
- Migrate CDC event format — keep the TS-side consumer working via a Go→TS event bridge
- Validate data equivalence with old state via parallel-run tests

**Phase 3 (months 5-6): Port agent adapters to Go**
- Start with `claude-code` (highest volume)
- Port `codex`, `wafer`, `minimax`, `opencode` in that order
- Keep TS adapters as fallback during port

**Phase 4 (months 6+): Gradual CLI migration**
- New Go `ao` binary (Cobra, like upstream)
- Old TS `ao` binary shimmed to call new Go daemon over HTTP
- Deprecate TS CLI after 6 months of stability

**Pros:**
- Preserves Skeptic + custom plugins (operator moat)
- Brings upstream's storage reliability, HTTP API, ConPTY support
- Risk-bounded: each phase is shippable
- TS→Go port is mechanical for storage; only the agent adapters have semantic complexity

**Cons:**
- 6+ months of dual maintenance (TS fork + Go daemon)
- Need Go expertise on the fork team
- CDC + sqlite is a behavioral change for state consumers (must validate equivalence)

**Risks to manage:**
- Loopback HTTP auth — fork's existing TS code trusts local env; Go daemon needs same trust model
- Process supervision — fork's `ao start` boots the daemon; must keep it idempotent
- Skeptic's TS evaluation must work whether invoked from TS CLI or Go CLI

**When this is right:** If operator wants **upstream's reliability/storage gains** without losing **operator-tuned features**.

### Path C — Full fork → Go rewrite

**What it means:** Replace the entire TS monorepo with a Go fork of upstream. Re-implement Skeptic, fork-specific SCM adapters, evidence gates, and webhook opt-in logic in Go.

**Pros:**
- Future-proof. Same tech stack as upstream.
- Single language. Easier contributor onboarding.
- All of upstream's features become available.

**Cons:**
- **Kills fork velocity for 6-12 months.** All ongoing PRs (currently 4+ open) blocked or rebased.
- Re-implement Skeptic in Go: `llm-eval-shared.ts` fallback chain, CodeRabbit/Skeptic verdict parsing, PR Diff Coverage logic, claim class floors — all must be ported and re-tested.
- Re-implement fork-specific SCM adapters (`smartclaw`, `worldarchitect`, `ai_universe`, `ai_universe_frontend`) in Go.
- Re-implement Evidence Gate in Go.
- Re-implement webhook opt-in logic in Go.
- Massive test rewrite — fork has 700+ tests in TS.

**When this is right:** Almost never for an actively-used fork with operator customizations. This is the "greenfield rewrite" path; only justifiable if the operator is ready to pause the fork for a year.

---

### Path D — Go default + explicit TS carve-outs (operator variant)

**What it means:** Adopt Go as the default language for all new code in the fork. Maintain a TS "island" for explicitly named features that are either (a) working and high-risk to port, or (b) genuinely TS-dependent. Every TS file must justify its existence.

**Rule of thumb:** before opening a new `.ts` file, write a 2-line comment explaining why it can't be Go. Audit after 6 months.

**TS islands justified:**

| Island | Justification |
|---|---|
| **Skeptic** (`packages/cli/src/lib/llm-eval-shared.ts`) | Multi-model LLM evaluator with Codex → Claude fallback chain. Stable stdin-pipe semantics, prompt escaping already battle-tested. Porting adds 0 value. |
| **`agy` CLI wrapper** (`packages/cli/src/lib/llm-eval-agy.ts`) | `agy` is used by skeptic as LLM eval fallback. The CLI binary stays as an external dep; the wrapper file stays as TS. |
| **Anything else** | Justify in code comment, audit quarterly. |

**Antigravity runtime/worker — REMOVED (not a TS island):**

Operator confirmed (2026-06-25): the **Antigravity runtime** (driving Google Antigravity IDE via Peekaboo/CDP, `packages/plugins/runtime-antigravity/` 804K) is **not used**. Only the `agy` CLI binary is used (by skeptic). Refactor:

- DELETE `packages/plugins/runtime-antigravity/` (804K, 19 files, 10 tests, 7,533 LOC)
- DELETE `packages/plugins/agent-antigravity/` (184K, 6 files, 5 tests)
- KEEP `packages/cli/src/lib/llm-eval-agy.ts` (used by skeptic)
- EDIT `packages/core/src/config.ts` — change `agent: z.string().default("antigravity")` to `claude-code` (or `wafer`)
- EDIT `packages/core/src/fork-lifecycle-manager.ts` — drop `parseAntigravityQuotaReset()`
- EDIT `packages/core/src/session-manager.ts` — update fall-through comment
- EDIT `packages/core/src/orchestrator-prompt.ts` — remove `/antig\` slash command
- EDIT `packages/core/src/plugin-registry.ts` — remove 2 registry entries
- EDIT `packages/cli/src/lib/plugins.ts`, `detect-agent.ts`, `commands/spawn.ts` — remove Antigravity references

Estimated: ~50–150 LOC of edits + 7,533 LOC of deletions. Single PR after operator confirmation.

**Launchd layer — fork-only TS island (not a port candidate):**

Operator wants launchd but upstream doesn't have it. Investigation (Subagent C, 2026-06-25): upstream's process supervision is **Electron-anchored** — `Electron supervisor → Go daemon → tmux/conpty runtime → agent CLI`. The Go daemon never daemonizes; it expects to be a child process. Upstream's `*.plist` count = 0. The fork's launchd plists wrap **fork-only jobs** (lifecycle-worker, health-guardian, novel-daily, perplexity-keystone) that have no upstream equivalent.

Decision: **KEEP fork's `launchd/*.plist.template` + `scripts/setup-launchd.sh` as a TS-shell layer** (or Go rewrite — TBD). NOT a port candidate into upstream. Future migration: when fork cuts over to Go daemon, lifecycle-worker job may collapse into upstream's HTTP `/api/v1/sessions/spawn` endpoints, and the launchd plist would re-target `ao start` (Go daemon's daemonized mode) instead of `node packages/cli/dist/index.js lifecycle-worker`. **Future concern, not now.**

**Web app — keep fork Next.js + optionally cherry-pick 2 features:**

Operator thought upstream should already have a web app. Investigation (Subagent B, 2026-06-25): upstream has **Electron 33 + React 19 + TanStack Router** (`frontend/`, 23,520 LOC, 27 OpenAPI routes, 6.1MB). Fork has **Next.js 15.5 + React 19** (`packages/web/`, 18,508 LOC, 18 hand-written routes, 167MB). They speak to different backends (upstream's frontend → Go daemon; fork's web → TS AO core in-process).

Upstream explicitly clones the fork's `packages/web/src` design (per upstream `DESIGN.md:1-12` + `CLAUDE.md:14-17`). **The fork is upstream's design source of truth.**

Decision: **KEEP_FORK_WEB as the primary web entry.** Don't adopt Electron. Optionally cherry-pick:
- `BrowserPanel`-equivalent as a fork component (iframe wrapping `ao preview` output) — currently absent
- `openapi-typescript` codegen style for the fork's `/api/*` routes once stabilized (replaces hand-written route types)

**Hard gates (license + namespace + module path):**

| Gate | Status | Required action |
|---|---|---|
| **License** | NO upstream LICENSE file, NO headers in main.go / root.go | **Verify MIT-compatibility with upstream maintainers before vendoring any Go code.** Hard gate. |
| **Namespace switch** | Upstream uses `~/.ao/` (RunFilePath, DataDir); fork uses `~/.agent-orchestrator/` | Decide: adopt `~/.ao/` (breaking for existing operators) OR keep `~/.agent-orchestrator/` (override default). |
| **Module path** | Upstream is `github.com/aoagents/agent-orchestrator/backend`; fork is `jleechanorg/agent-orchestrator` | Pick `github.com/jleechanorg/agent-orchestrator/backend` before first Go import. |

**Phase 0 (weeks 1-2): Audit TS deps of every fork plugin**
- For each of the 38 plugins in `packages/plugins/`, check: does it have a hard TS dep on something upstream Go can't easily replicate?
- Output: a markdown table per plugin: `name | hard TS deps | port candidate (Y/N)`
- Decisions: if a plugin has zero TS deps, mark "port candidate." If it has hard TS deps, mark "TS island" with justification.

**Phase 1 (months 1-2): Stand up Go fork of upstream under `backend/`**
- Vendor `internal/daemon`, `internal/storage/sqlite`, `internal/cdc`, `internal/httpd`, `internal/config`
- Strip fork-specific UI/Skeptic — those stay in TS
- Expose the Go daemon's HTTP API as `ao`'s new backend
- Keep the existing TS `ao` CLI as a fallback during migration (shim: Go CLI calls TS CLI as subprocess for any unimplemented subcommand)

**Phase 2 (months 2-3): Migrate state + storage**
- Replace `state.json` model with SQLite + goose migrations
- Use `internal/legacyimport/` to migrate existing fork state
- Validate data equivalence via parallel-run for 30 days
- Keep TS-side state consumers working via Go→TS event bridge

**Phase 3 (months 3-5): Port agent adapters**
- Start with `claude-code` (highest volume), then `codex`, `wafer`, `minimax`, `opencode`, `base`
- Port `runtime-tmux`, `workspace-worktree`, `scm-github` in parallel (these are infrastructure)
- Keep TS adapters as fallback during port

**Phase 4 (months 5-6): Port fork-specific logic**
- `7-green` enforcement → Go subcommand + GitHub Action (YAML)
- `evidence-gate` → Go subcommand + GitHub Action
- PR Diff Coverage Rule 10 → Go
- Admin-squash-bypass pattern → Go (just `gh pr merge` invocation)
- `mergeConfigOverlay` env expansion fix → Go
- `running.json` register-before-banner → Go
- Lifecycle-worker launchd → update plist binary path; logic in Go

**Phase 5 (months 6-8): Port plugins**
- All 38 plugins → Go adapters, one PR each
- Antigravity runtime: port IF TS deps audit allows; else keep TS as named island
- MCP-AO plugin: port (Go MCP client libs exist)

**Phase 6 (months 8-9): Deprecate TS CLI**
- New Go `ao` binary is canonical
- Old TS `ao` binary becomes a thin shim → `ao-go <subcommand>` for any subcommand not yet ported
- Document migration timeline; remove TS binary after 90 days of no shim hits

**Phase 7 (months 9-12): Skeptic carve-out verified + drift cleanup**
- Skeptic runs as TS subprocess invoked by Go `ao skeptic verify`
- All TS files justified in code comments
- Quarterly TS audit

**Pros:**
- Preserves Skeptic (operator moat)
- Bounded scope — TS islands are explicit, audited
- Each phase is shippable
- Future-proof — fork stays close to upstream

**Cons:**
- 9-12 months of dual maintenance
- Phase 0 audit is non-trivial (38 plugins to check)
- Antigravity runtime decision blocks Phase 5
- Skeptic invocation path change (in-process → subprocess) may regress gate behavior — must validate

**When this is right:** If operator wants **upstream's reliability/storage gains** AND **clear default** for new code, with bounded risk via named TS islands.

---

## Skeptic stays TS/tsx (operator decision recorded)

Per operator: **"maybe my skeptic agent can stay as tsx for now"**

**Implication:**
- Skeptic's TS evaluator (`packages/cli/src/lib/llm-eval-shared.ts`) remains the source of truth for `ao skeptic verify`
- In Path B, the Go daemon invokes the TS Skeptic via subprocess (or HTTP wrapper)
- In Path C, Skeptic would need a Go port; defer until later
- In Path D, Skeptic is a named TS island; no Go rewrite planned

**No Go rewrite of Skeptic in any path.**

---

## Recommendations

### Immediate (this week)

1. **Document the audit findings** in a memory entry (`feedback_2026-06-25_upstream_go_switch.md`) so future sessions don't re-investigate.
2. **Create bead `bd-zrwq`** as the tracking work item for Path D decisions.
3. **Do NOT merge upstream Go code wholesale** — module path is `github.com/aoagents/...`, license-check before any copy.

### Short-term (next 1-2 weeks)

4. **Decide Path A vs Path B vs Path D** with operator. Path C is rejected (operator wants to preserve Skeptic + custom plugins; Path D is the operator's preferred variant with named TS carve-outs).
5. **If Path D**: start Phase 0 — audit TS deps of every fork plugin (38 plugins, ~54K LOC).
6. **If Path A**: define what "selective port" means — at minimum, port the storage + HTTP daemon from upstream to TS (or accept the drift).
7. **Decide Antigravity runtime** (Path D blocker) — verify TS deps in 1-day spike.

### Medium-term (months 2-6 if Path B)

8. Phase 1 — vendor Go daemon, expose HTTP API, prove TS CLI can call it.
9. Phase 2 — migrate storage; run dual-write period.
10. Phase 3 — port agent adapters one by one.

### Operator checkpoints

- End of Phase 1: Go daemon stable + TS CLI calling it? → Continue.
- End of Phase 2: State equivalence validated via parallel-run? → Continue.
- End of Phase 3: All fork-used agents ported? → Continue.
- End of Phase 4: Old TS CLI removed? → Path B complete.

---

## Open questions for operator

1. **Is operator willing to invest in Go expertise** for the fork team? (Path B requires Go fluency; Path A doesn't.)
2. **How much of upstream's storage model do we want?** (Fork's `state.json` is simpler than SQLite + goose; the gain is durability, the cost is operational complexity.)
3. **How many of upstream's 23 agent adapters do we actually need?** (Fork uses 5; the other 18 are upstream's market coverage.)
4. **Does operator want ConPTY / Windows support?** (Fork is macOS-only today; ConPTY would unlock Windows.)
5. **What's the cutoff date for accepting TS-only drift?** (E.g., "if upstream adds X by YYYY-MM-DD and we don't have it, we Path B regardless.")

---

## References

- **Slack thread** (1 root message, no decisions): https://jleechanai.slack.com/archives/C0ALSKLU9KM/p1782382574896179
- **Upstream repo** (now branded "ReverbCode"): https://github.com/agentwrapper/agent-orchestrator
- **Upstream Go module path**: `github.com/aoagents/agent-orchestrator/backend`
- **Upstream architecture doc**: `/tmp/upstream-ao/docs/architecture.md`, `/tmp/upstream-ao/docs/STATUS.md`
- **Fork-only tracking PR** (TS→TS refactor): https://github.com/jleechanorg/agent-orchestrator/pull/712
- **Recent merged fork PR** (webhook opt-in): https://github.com/jleechanorg/agent-orchestrator/pull/727
- **Bead**: TBD — to be created as `bd-upstream-go-migration`
- **Memory entry**: TBD — to be created at `feedback_2026-06-25_upstream_go_switch.md`