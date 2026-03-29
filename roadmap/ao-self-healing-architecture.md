# AO Self-Healing Architecture

Audited 2026-03-29. Documents how AO components start, restart, and self-heal.

## Resurrection Chain

```
launchd (macOS init)
  -> ai.agento.orchestrators (KeepAlive: true, ThrottleInterval: 60s)
    -> ao start <project> x 7 (parallel, idempotent)
      -> lifecycle-worker <project> (nohup &, per-project)
        -> backfillUncoveredPRs -> ao spawn -> worker sessions
        -> session-reaper -> kills zombies on merged PRs
        -> orphan-worktree-sweep (every 5min)
      -> orchestrator tmux session (per-project)
    -> dashboard (first project only)
  -> com.ao-runner-watchdog (StartInterval=3600)
    -> ao doctor --fix -> restarts dead self-hosted runners
  -> com.openclaw.gateway (KeepAlive: true)
  -> ai.agento.notifier (KeepAlive: true)
```

## Component Matrix

| Component | Started by | Crash recovery | Recovery time |
|---|---|---|---|
| ai.agento.orchestrators | launchd | KeepAlive: true | ~60s (ThrottleInterval) |
| lifecycle-worker (per-project) | ao start (nohup &) | Indirect: launchd -> ao start loop | Minutes (waits for ALL ao-start to finish) |
| orchestrator session (tmux) | ao start | Recreated on next ao start run | Minutes |
| worker session (ao-NNNN) | ao spawn (from backfill or manual) | backfillUncoveredPRs for PR-bound; none for non-PR tasks | Poll cycle (~60s) |
| self-hosted runners | ~/.ao-runner.d/*.sh | com.ao-runner-watchdog (hourly) | Up to 1 hour |
| OpenClaw gateway | launchd | KeepAlive: true | Seconds |
| notifier | launchd | KeepAlive: true | Seconds |

## Launchd Services

| Label | State (2026-03-29) | KeepAlive | Purpose |
|---|---|---|---|
| ai.agento.orchestrators | RUNNING | YES | Central: manages all 7 projects |
| ai.agento.lifecycle-all | not running | NO | LEGACY -- superseded by orchestrators |
| com.agentorchestrator.start-all | exit 0 | NO | LEGACY -- boot-once, superseded |
| com.agentorchestrator.lifecycle-* | deregistered | -- | LEGACY -- removed by setup-launchd.sh |
| com.ao-runner-watchdog | installed | hourly | Runner health (PR #294) |
| com.openclaw.gateway | RUNNING | YES | OpenClaw HTTP gateway |
| ai.agento.notifier | RUNNING | YES | Slack notifications |

## Projects Managed

ai.agento.orchestrators manages: jleechanclaw, worldarchitect, agent-orchestrator, ralph, claude-commands, worldai-claw, mctrl-test (ghost -- config removed)

Extra (not in plist): ai-universe-living-blog

## Known Self-Healing Gaps

1. **Individual LW crash recovery delayed** -- launchd restarts only when ALL ao-start processes finish (wait). Single-project crashes may take minutes.
2. **Non-PR worker tasks lost** -- backfill only covers PR-bound workers. Tasks without PRs (monitoring, ad-hoc) are not resurrected.
3. **Runner auto-provisioning** -- ao doctor --fix restarts existing runners but cannot create configs for unconfigured repos (bd-61rj).
4. **mctrl-test ghost** -- listed in orchestrators plist but absent from config; start fails silently.
5. **Main repo branch invariant** -- ao start kickstart can trigger workers that switch main repo off main branch.

## Key Files

- Plist: ~/Library/LaunchAgents/ai.agento.orchestrators.plist
- Bootstrap: scripts/start-all.sh (idempotent per-project startup)
- Installer: scripts/setup-launchd.sh (generates + installs plists from templates)
- Templates: launchd/ai.agento.lifecycle-all.plist.template
- Config: ~/.openclaw/agent-orchestrator.yaml
- Data: ~/.agent-orchestrator/bb5e6b7f8db3-<project>/
