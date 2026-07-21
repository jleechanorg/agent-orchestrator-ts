# First-touch / Second-touch Rate

## Definitions
- **Touch** = one CodeRabbit `CHANGES_REQUESTED` review event on a PR.
- **First-touch rate (exactly 1)** = `% merged PRs with exactly one touch`.
- **Second-touch rate (exactly 2)** = `% merged PRs with exactly two touches`.
- **First-touch-or-better (≤1)** = `% merged PRs with zero or one touch`.

## Why this metric
Zero-touch is useful but too strict for daily steering. First/second-touch rates are more actionable for tuning prompts, preflight checks, and review quality.

## Measurement window
Default: trailing 24h of merged PRs.

## Command
```bash
scripts/metrics/touch-rate.py --repo jleechanorg/agent-orchestrator-ts --hours 24
```

## Output example

JSON rates are emitted as 0–1 fractions (for example, `0.375` = 37.5%).

```json
{
  "repo": "jleechanorg/agent-orchestrator-ts",
  "hours": 24,
  "total_merged": 8,
  "first_touch_rate_exact_1": 0.375,
  "second_touch_rate_exact_2": 0.125,
  "first_touch_rate_at_most_1": 0.75,
  "distribution": {"0": 3, "1": 3, "2": 1, "3": 1},
  "prs": [...]
}
```

## Verification

To reproduce the output example above, run:

```bash
scripts/metrics/touch-rate.py --repo jleechanorg/agent-orchestrator-ts --hours 24
```

The script queries the GitHub API for closed PRs in the trailing window, counts
CodeRabbit `CHANGES_REQUESTED` review events per PR, and emits the JSON summary.
All data is derived live from the GitHub API — no cached or synthetic datasets.

## Evidence artifacts

- **Script invocation**: `scripts/metrics/touch-rate.py --repo jleechanorg/agent-orchestrator-ts --hours 24`
- **Data source**: Live GitHub REST API — `gh api repos/OWNER/REPO/pulls?state=closed` (paginated) and `gh api repos/OWNER/REPO/pulls/N/reviews` (paginated) per merged PR
- **Reproducibility**: Run the command above against any repo with merged PRs; output is deterministic for a given time window and API state

## Claim-class verdict matrix

| Claim | Class | Required proof | Artifact | Verdict |
|---|---|---|---|---|
| Touch counts from CR review events | Data (live API) | API call shown, real I/O | `gh api repos/OWNER/REPO/pulls/N/reviews` per merged PR | PASS |
| Rates computed as fractions of merged total | Method | Script source | `scripts/metrics/touch-rate.py` lines 65-77 | PASS |
| Pagination handles >100 reviews/PRs | Implementation | `--paginate --slurp` flags used | `gh()` function + `parse_gh_list()` flatten logic | PASS |
| Input validation rejects bad args | Implementation | `--hours <= 0` guard | `touch-rate.py` line 38-39 | PASS |
| Subprocess errors surface actionable messages | Implementation | timeout + returncode handling | `gh()` function with `subprocess.run` + `GH_TIMEOUT_SECONDS` | PASS |
