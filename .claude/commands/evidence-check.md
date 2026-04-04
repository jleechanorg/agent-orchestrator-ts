# /evidence-check — Validate PR body against Evidence Gate locally

Run this before pushing a PR to catch Evidence Gate failures locally instead of waiting for CI.

## Usage

```
/evidence-check [--pr N]
```

- `--pr N`: PR number to check. If omitted, detects from current branch.

## What it checks

The Evidence Gate CI check (`wholesome.yml` "Evidence Has Media Attachment") has three hard requirements:

1. **Evidence section present** — PR body must contain `## Evidence` (H2 heading)
2. **Claim class** — Must have `**Claim class**: <unit|integration|pipeline-e2e|pr-lifecycle-e2e|merge-gate>`
3. **Media proof** — Evidence section must contain EITHER:
   - Markdown image with HTTPS URL: `![alt](https://...)`
   - OR a code block: `\`\`\``
   - OR structured text: `**Terminal output**:` or `**Test output**:` followed by non-whitespace

**What FAILS the CI check:**
- `**Media**: <path>` — placeholder path without actual image URL
- `**Test output**: <value>` — inline value without code block or URL
- No Evidence section at all

## Exit codes

- `0`: PR body passes all Evidence Gate checks
- `1`: One or more checks fail — fix before pushing

## Examples

```
/evidence-check --pr 281
```

Output:
```
=== Evidence Gate Local Check ===
PR #281: [agento] fix: use --admin instead of --auto in gh pr merge

✓ Evidence section found
✓ Claim class: merge-gate
✓ Media found: code block

PASS: PR body will pass Evidence Gate CI
```
