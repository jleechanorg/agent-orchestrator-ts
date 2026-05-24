---
name: domain-lock
description: "Guidelines and operational procedures for collision detection and domain-level lock management across all agent repositories."
---

# Domain Lock and Area Lock Discipline

Authoritative guidelines and operational procedures for collision detection and domain-level lock management across all agent repositories.

---

## 1. Core Philosophy

To avoid concurrent agent spawner or developer collision when working on hot-spot files in active repositories, the environment implements a **Domain-Based Parallel Collision Detection** system (called `merge_train` / `domain_lock`).

### Zero-In-Repo Code Policy (Key Tenet)
Target repositories (such as `worldarchitect.ai`, `ai-universe`, etc.) MUST contain **only** configuration file(s) (`file_domains.yaml`) at their root.
- **No Python-side adapters, custom integration scripts, or integration tests** should reside in client repositories.
- The **Agent Orchestrator (AO)** core TypeScript codebase is entirely responsible for spawning, reserving, and releasing domain locks.

---

## 2. Minimal Repo-Level Config: `file_domains.yaml`

Each target repository contains a single registry configuration at the root: `file_domains.yaml`.
This file maps glob patterns to domain names and designates code owners/teams:

```yaml
domains:
  mvp-core:
    paths:
      - "mvp_site/world_logic.py"
      - "mvp_site/agents.py"
    owners:
      - "@core"
  
  ci-workflows:
    paths:
      - ".github/workflows/*.yml"
    owners:
      - "@infra"
```

---

## 3. Installation Script: `install.sh`

The `merge_train` repository contains the authoritative, automated installer script:
- **Location:** `/Users/jleechan/projects/merge_train/install.sh`

### Usage:
From within any target repository:
```bash
/Users/jleechan/projects/merge_train/install.sh
```

### What it does:
1. Installs the `merge_train` python package locally in development/editable mode.
2. Generates a skeleton `file_domains.yaml` config file at the target root if one doesn't exist.
3. Automatically sets up and symlinks the Git `pre-commit` hook (`.git/hooks/pre-commit`).
4. Smoke-tests the local CLI configuration to ensure immediate readiness.

---

## 4. Hooks and CLI Integration

All agent CLIs (Claude Code, Codex, OpenCode, Agento, wafer/agy) automatically integrate via two primary mechanisms:

### A. Pre-Commit Hook (Commit Time)
Created automatically by the installer under `.git/hooks/pre-commit`.
- When an agent or developer attempts `git commit`, the hook extracts the staged diff's files and invokes the local `domain_lock check` in `--diff-mode`.
- This ensures symbol-level checking so multiple agents can edit disjoint functions/symbols in the same file simultaneously without blocking.

### B. Core Spawner Integration (Spawn Time)
Wired natively into the Agent Orchestrator:
- **Pre-Spawn Gate:** Checks for active locks before spawning an agent session.
- **Acquire/Reserve:** Automatically registers reservations on session spawn and when a PR is newly discovered.
- **Release:** Automatically removes reservations when the session terminates or completes.

---

## 5. Exit Codes & Collision Handling

When the gate returns a conflict (`HELD: <domain> by PR#<N>`), agents must adhere to the following:
- **Exit 0:** Domain/symbol free or owned by current PR. Proceed immediately.
- **Exit 1:** Domain/symbol held. Refuse spawn or commit. Do not force or retry blindly. Reschedule or narrow the scope.
- **Exit 2:** Configuration/registry error. Stop and fix the configuration path/parameters.
