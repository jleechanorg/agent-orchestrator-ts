# Video Evidence Roadmap

**Created:** 2026-04-06
**Epic bead:** bd-vide1
**Goal:** Every integration+ PR must include real captioned tmux console video AND UI video (where applicable). N/A is not acceptable for integration+ claims.

## Current state (as of 2026-04-06)

- Fix 1 (bd-cam93): ✅ MERGED via PR #390 — Terminal media N/A scoped to unit/docs-only claims in evidence-gate.yml
- Fix 2 (bd-4ze23): 🔄 IN PROGRESS — ao-3327 implementing agentRules + agent-orchestrator.yaml.example wiring
- Fix 3 (bd-7s0d): 🔄 IN PROGRESS — ao-3327 implementing claim class floor in evidence-gate.yml
- Captioned URL enforcement (bd-vidcap): ⏳ PLANNED — after Fix 2 lands
- AO builtin eloop for agent-orchestrator (bd-elcfg): ⏳ PLANNED — config missing

## 40-PR audit finding

Zero real video artifacts across all 40 merged PRs. Every `**Terminal media**` line is `N/A`. Root causes: 3 structural gaps (see `./evidence-theater-diagnosis.md`).

## Path to true video evidence

### Step 1: Fix 2 — agentRules media wire (bd-4ze23) ← IN PROGRESS

**Target file:** `agent-orchestrator.yaml.example`

```yaml
agentRules: |
  For PRs with claim class `integration` or higher, BEFORE creating the PR body:
  1. Run ~/.claude/skills/tmux-video-evidence/ to capture terminal session as captioned mp4/gif
  2. For PRs touching UI files (*.tsx, *.css, *.html), run ~/.claude/skills/ui-video-evidence/
  3. Upload artifacts to gist or accessible URL
  4. Set **Terminal media**: <URL> in Evidence section — NEVER N/A for integration+ claims
```

### Step 2: Fix 3 — Claim class floor (bd-7s0d) ← IN PROGRESS

**Target file:** `.github/workflows/evidence-gate.yml`

Reject `unit`/`documentation-only` claims when `.ts`/`.js`/`.py`/`.go` files changed, unless `**Claim floor override**:` is present.

### Step 3: Caption enforcement (bd-vidcap) ← PLANNED

**Target file:** `.github/workflows/evidence-gate.yml`

After Fix 2 lands, extend evidence-gate to validate:
- Terminal media URL is a real HTTPS URL (not `N/A`, not empty)
- URL points to a captioned `.gif` or `.mp4` artifact (matches the "true video evidence" definition below)
- UI media URL required if PR touches `*.tsx`/`*.css`/`*.html` files

### Step 4: Enable AO builtin eloop (bd-elcfg) ← PLANNED

**Target file:** `~/.openclaw/agent-orchestrator.yaml`

Add under `projects.agent-orchestrator:`:
```yaml
evolveLoop:
  enabled: true
  pollCadence: lightweight
  autonomousFixScopes:
    - config-edit
    - claw-dispatch
    - bead-create
  blockedScopes: []
  knowledgeBaseDir: ~/.ao-evolve-knowledge
  zeroTouchWindow: 24h
```

The code (PRs #376, #378, #380, #381) is merged. Config missing = eloop never fires.

### Step 5: Monitor via eloop ← PLANNED (depends on Step 4)

Once eloop fires, it will:
- Audit each merged PR for video evidence artifacts
- Dispatch workers to retroactively produce evidence where missing
- Gate future merges on non-N/A Terminal media for integration+ claims

## What "true video evidence" means

| Evidence type | Format | Required for |
|---------------|--------|--------------|
| Terminal media | Captioned `.gif` or `.mp4` of tmux session showing test run | `integration`+ |
| UI media | Captioned `.gif` or `.mp4` of browser interaction | `integration`+ PRs touching UI files |
| Repro gist | Link to reproducible shell/test script | `integration`+ |
| Terminal test output | Fenced code block with actual test output | `integration`+ |

**Captioned** means: text overlay on the video showing what is being demonstrated, not just raw screen capture.

## Skills that exist (user scope)

These skills exist at `~/.claude/skills/` but have no caller:
- `tmux-video-evidence/` — captures tmux session as video
- `ui-video-evidence/` — captures browser/UI as video
- `smoke-test-local/` — runs local smoke test

Fix 2 wires these as callers via agentRules. Fix 3 makes the gate reject missing evidence.

## Related

- `./evidence-theater-diagnosis.md` — root cause analysis
- bd-4ze23 — Fix 2 (in progress, ao-3327)
- bd-7s0d — Fix 3 (in progress, ao-3327)
- bd-vide1 — this epic
- bd-vidcap — caption URL enforcement
- bd-elcfg — enable AO builtin eloop
