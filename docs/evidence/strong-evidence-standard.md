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
   - HTTPS screenshot or video URL under `**Terminal media**:` with a caption that
     mentions `tmux` or `terminal` **outside** the label line
3. **Terminal test output** (required — CI enforces via evidence-gate.yml)
   - `**Terminal test output**:` with a fenced code block (triple backtick: ``` ` ```bash ` or tilde: `~~~`) showing
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

````md
## Evidence
**Claim class**: pipeline-e2e
**Verdict**: PASS

**Repro gist**: https://gist.github.com/your-username/...
(Clone and run steps to reproduce the behavior)

**Terminal media**: https://.../screenshot.png
Shows tmux pane with the key behavior change (caption outside label)

**Terminal test output**:
```
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
````

## Notes

- Placeholder text (`<value>`, `<screenshot path>`, `TODO`, `TBD`) is invalid.
- "Simulated" output is invalid.
- Unit/integration claims may use terminal evidence without media when no UI interaction exists.
