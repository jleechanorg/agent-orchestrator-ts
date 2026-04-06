# Strong Evidence Standard (Cursor-style)

Use this standard for any claim beyond simple unit test output. The `integration` claim class is explicitly included in the strong-proof requirement (see list below).

## Core principle

**Never trust claim-only output.**
A PR must contain verifiable artifacts that let reviewers confirm behavior quickly.

## Required evidence bundle (non-unit claims)

For claim classes `integration`, `pipeline-e2e`, `pr-lifecycle-e2e`, and `merge-gate`, include all of:

1. **Repro gist** (required for reviewer approval — CI validates verdict format only)
   - `**Repro gist**: https://gist.github.com/...` with clone-and-run steps
2. **Terminal media** (required — CI enforces via evidence-gate.yml Evidence Bundle v2 step)
   - **HTTPS URL** to a real artifact (not `N/A` for integration+). Prefer recognizable patterns:
     `.mp4`, `.gif`, `.cast`, links on `gist.github.com` or `asciinema.org`, or `github.com/user-attachments/assets/…`.
     Unknown HTTPS URLs still **pass** the gate but may surface a **CI warning** — use a known pattern when possible.
   - A **caption** that mentions `tmux` or `terminal` **outside** the label line
3. **Terminal test output** (required — CI enforces via evidence-gate.yml)
   - `**Terminal test output**:` with a fenced code block (backtick triple: &#96;&#96;&#96;bash or tilde: &#126;&#126;&#126;) showing
     real command output (must reference a concrete test command: `pnpm test`, `pytest`, etc.)
4. **UI media** (or explicit no-UI line — CI enforces exact `N/A - no UI changes`)
   - HTTPS screenshot/video URL with caption, **OR** exact text `N/A - no UI changes`
5. **Self-validation evidence**
   - Explicit verification language: `verified`, `confirmed`, `reproduced`, `error case`, etc.
     (a bare `**Self-validation**:` label with no following statement does **not** satisfy this)

## Reviewer intent

Review should be fast and objective:
- the media shows user-visible behavior
- the logs/output show what actually ran
- the validation notes show the agent tested both happy path and failure/edge behavior

## Suggested PR Evidence skeleton

````````markdown
## Evidence
**Claim class**: pipeline-e2e
**Verdict**: PASS

**Repro gist**: https://gist.github.com/your-username/...
(Clone and run steps to reproduce the behavior)

**Terminal media**: https://github.com/user-attachments/assets/00000000-0000-0000-0000-000000000000
Captioned terminal recording: tmux pane shows the command output after the fix (tmux/terminal must appear outside the label line)

**Terminal test output**:
```bash
$ pnpm test
  ✓ my-test  ...
  ...
```

**UI media**: https://.../flow.mp4
Video of the key user flow (or `N/A - no UI changes`)

**Self-validation**:
- Reproduced the issue on old SHA
- Verified the fix on new SHA
- Confirmed no regressions in related flows
````````

## Notes

- Placeholder text (`<value>`, `<screenshot path>`, `TODO`, `TBD`) is invalid.
- "Simulated" output is invalid.
- Unit claims (and only unit) may use terminal evidence only — no repro gist or UI media required. `integration` claims require the full bundle above; "N/A - no UI changes" is accepted when there is no UI interaction.
