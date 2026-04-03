# Strong Evidence Standard (Cursor-style)

Use this standard for any claim beyond simple unit/integration test output.

## Core principle

**Never trust claim-only output.**
A PR must contain verifiable artifacts that let reviewers confirm behavior quickly.

## Required evidence bundle (non-unit claims)

For claim classes `pipeline-e2e`, `pr-lifecycle-e2e`, and `merge-gate`, include all of:

1. **Media artifact**
   - At least one screenshot/video URL (`https://...png|jpg|gif|webp|mp4|webm|mov`)
2. **Execution artifact**
   - Real command/test output (code block or structured terminal/test output)
3. **Self-validation evidence**
   - Explicit verification language proving the agent tested outcomes (for example: `verified`, `error case`, `before/after`, `reproduced`)

## Reviewer intent

Review should be fast and objective:
- the media shows user-visible behavior
- the logs/output show what actually ran
- the validation notes show the agent tested both happy path and failure/edge behavior

## Suggested PR Evidence skeleton

```md
## Evidence
**Claim class**: pr-lifecycle-e2e
**Verdict**: PASS

**Media**:
- https://.../flow.mp4
- https://.../after-fix.png

**Terminal output**:
~~~bash
# real command output here
~~~

**Self-validation**:
- Reproduced bug on old head SHA
- Verified fixed behavior on new head SHA
- Ran error-case validation (invalid input) and confirmed expected guardrail
```

## Notes

- Placeholder text (`<value>`, `<screenshot path>`, `TODO`, `TBD`) is invalid.
- "Simulated" output is invalid.
- Unit/integration claims may use terminal evidence without media when no UI interaction exists.
