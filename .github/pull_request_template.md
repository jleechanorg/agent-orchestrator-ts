## Summary

<!-- Brief what/why. PR titles should start with `[agento]` (see wholesome checks). -->

## Evidence

<!-- Required by Evidence Gate CI (.github/workflows/evidence-gate.yml). See docs/evidence/README.md (Evidence Bundle v2). -->

**Claim class:** <!-- documentation-only | unit | integration | pipeline-e2e | pr-lifecycle-e2e | merge-gate -->

<!-- If Claim class is unit or documentation-only but the diff touches .ts/.js/.py/.go/.sh/.json, add: -->
<!-- **Claim floor override:** <one-line justification> -->

**Repro gist:** <!-- `https://gist.github.com/...` or N/A with reason (label must match this exact spelling for parsers) -->

**Terminal test output:**

<!-- Fenced log with a line like `$ pnpm ...` / `$ npm test` / `vitest` / etc. -->

```text
(paste command + output)
```

**Terminal media:** <!-- Video GIF/MP4/CAST (HTTPS URL) or N/A with reason. Must be captioned with commit SHA. -->

**UI media:** <!-- Video GIF/MP4 (HTTPS URL) or N/A - no UI changes. Must be captioned with commit SHA. -->

**Verdict:** <!-- PASS | INSUFFICIENT | FAIL — mandatory for Evidence Gate -->
