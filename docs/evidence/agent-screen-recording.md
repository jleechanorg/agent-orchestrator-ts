# Agent screen recording (non-unit claims) — worker instructions

**Mandatory when `**Claim class**` is not `unit`:** include an **`**Agent screen recording**:`** (or **`**Screen recording**:`**) block in `## Evidence` with:

1. **HTTPS video URL** — `.mp4`, `.webm`, `.mov`, or **YouTube** / **Loom** link (same checks as `evidence-gate.yml`).
2. **Caption** in that block — what the viewer sees (sandbox session, tmux window, app flow, key steps).
3. **Self-produced** — you (the agent) must **record** the session in your **sandbox / isolated run**, upload the file (GitHub PR **user attachment**, release asset, unlisted YouTube/Loom, etc.), and paste the **public** URL. **Do not** satisfy this with a prose-only description or a link to someone else’s video.

This is **in addition to** **Terminal media** (tmux screenshot/video), **Terminal test output** (fenced logs), and **UI media** / `N/A` — not a substitute.

## How to produce (Cursor-style)

1. Run the repro steps from your **Repro gist** in a **clean worktree** or documented sandbox.
2. Start **screen recording** (macOS: QuickTime / Screenshot toolbar; Linux: `ffmpeg`, OBS; or your runtime’s capture if applicable).
3. Show the **claim-relevant** flow: commands in terminal, UI if any, and outcomes (pass/fail, error path if you claim handling).
4. Keep it **short** (typically 30s–3m) and **legible** (readable font size, stable window focus).
5. **Upload** the file to a **stable HTTPS** URL; avoid expiring signed URLs unless renewed before review.
6. **Revert** any temporary flags before the **final** recording used in the PR.

## Why

Non-unit claims (integration, pipeline-e2e, merge-gate, etc.) assert behavior beyond isolated unit tests. A **moving** artifact gives reviewers merge confidence comparable to Cursor’s **agent-produced video** model, alongside static screenshots and logs.
