# Video evidence roadmap (Terminal media)

This document tracks how **Terminal media** in PR Evidence Bundle v2 moves from policy text to enforced, reviewable artifacts.

| Step | Bead / PR | What lands |
|------|-----------|------------|
| Fix 1 | bd-cam93 | Evidence gate rejects **N/A** for Terminal media on integration+ claims (aligned with `wholesome.yml`). |
| Fix 2 | bd-4ze23 | `agentRules` + example YAML wire **callers** for `tmux-video-evidence` (and related skills) so workers run capture before PR body. |
| Step 4 | bd-vidcap | `evidence-gate.yml` validates a **real HTTPS URL** exists, applies **known artifact patterns** (`.mp4`, `.gif`, `.cast`, `gist.github.com`, `asciinema.org`, `user-attachments`), **WARN-only** if URL present but pattern unknown; **FAIL** if URL missing or N/A for integration+. Caption must mention **tmux** or **terminal**. |

**Canonical workflow logic:** `.github/workflows/evidence-gate.yml` (strong-artifact step) and `.github/workflows/wholesome.yml` (Evidence Has Media Attachment).

**Human docs:** `docs/evidence/strong-evidence-standard.md` (skeleton + examples).
