# Gemini / Antigravity Repo-Local Baseline — agent-orchestrator

This file contains repository-specific baseline guidelines for Antigravity/Gemini.

## PR Merge Gating & Auto-Merge

### 7-Green Auto-Merge via Skeptic Cron (Mandatory)
* **Auto-Merge Behavior**: The GitHub Actions workflow `skeptic-cron.yml` runs periodically to evaluate open PRs against all 7-green conditions. If a PR passes all 7 gates (including a `VERDICT: PASS` comment posted by the skeptic verification agent), the workflow will automatically merge the PR.
* **Auto-Merge Configuration**: This behavior is controlled by the GitHub repository variable `SKEPTIC_CRON_AUTO_MERGE`. It is currently set to `"true"` for this repository.
* **Human Authorization Guard**: Even though auto-merge is active via GitHub Actions, agents must NEVER perform any manual or override merges (`gh pr merge` or otherwise) in chat unless the human user has typed `MERGE APPROVED` in the current turn.

## Memory Search Alias
* **Memory Search (`/ms`)**: In Claude Code / OpenClaw, the `/ms` command is an alias for `/memory_search` which searches across all memory systems (roadmap, beads, memories, wiki, history, etc.). Use this command or its equivalent to locate historical decisions and configurations.
