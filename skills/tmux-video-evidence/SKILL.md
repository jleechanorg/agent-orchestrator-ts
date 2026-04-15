---
name: tmux-video-evidence
description: How to record asciinema/tmux evidence videos that prove work was done correctly
---

# Tmux Video Evidence for Agent Work Verification

## Purpose

Record terminal-based evidence videos that another agent (or human) can review to verify that code changes, test results, and deployments are legitimate. The key principle: **the video must tie test output to a specific git commit and prove no tampering occurred during recording**.

## Prerequisites

```bash
# Required
brew install asciinema   # Terminal recorder (outputs .cast files)
brew install agg         # Converts .cast → .gif for embedding in docs/PRs
```

## Evidence Script Template

Create a script at `/tmp/<work_name>_evidence.sh`:

```bash
#!/bin/bash
# Evidence Recording Script — <PR/Work Item>
set -e

REPO_ROOT="<absolute path to repo>"
cd "$REPO_ROOT"

echo "╔═══════════════════════════════════════════════════════╗"
echo "║  <Title> — Evidence Capture                          ║"
echo "║  Recorded: $(date -u '+%Y-%m-%dT%H:%M:%SZ')                 ║"
echo "╚═══════════════════════════════════════════════════════╝"
echo ""

# ── 1. Git Provenance (MANDATORY — ties ALL output to this commit) ──
echo "━━━━━━━ 1. GIT PROVENANCE ━━━━━━━"
HEAD_SHA=$(git rev-parse HEAD)
BRANCH=$(git branch --show-current)
echo "  HEAD SHA:  $HEAD_SHA"
echo "  Branch:    $BRANCH"
echo "  Merge-base vs main: $(git merge-base HEAD origin/main)"
echo "  Commits ahead of main: $(git rev-list --count origin/main..HEAD)"
echo ""

# ── 2. Commit log ──
echo "━━━━━━━ 2. COMMIT LOG ━━━━━━━"
git log --oneline origin/main..HEAD
echo ""

# ── 3. Actual code diffs (not just --stat) ──
echo "━━━━━━━ 3. CODE DIFFS ━━━━━━━"
echo "--- diff --stat ---"
git diff --stat origin/main...HEAD
echo ""
echo "--- key file diffs (abbreviated) ---"
# Show actual diff for each important file:
for f in <list important changed files>; do
  echo "[$f]:"
  git diff origin/main...HEAD -- "$f" | head -60
  echo ""
done

# ── 4. PR/Work Item verification ──
echo "━━━━━━━ 4. PR STATUS ━━━━━━━"
gh pr view <PR_NUMBER> --json number,title,url,headRefName,state \
  -q '{number, title, url, headRefName, state}'
echo ""

# ── 5. Live test execution ──
echo "━━━━━━━ 5. LIVE TEST EXECUTION ━━━━━━━"
echo "Running tests against commit $HEAD_SHA..."

# Run your test suites:
cd "$REPO_ROOT/<package>"
npm test 2>&1 | grep -E "(PASS|FAIL|Test Suites|Tests:|Time:)"
echo ""

# ── 6. Post-test SHA check (MANDATORY — proves no commit change) ──
echo "━━━━━━━ 6. POST-TEST SHA VERIFICATION ━━━━━━━"
cd "$REPO_ROOT"
POST_SHA=$(git rev-parse HEAD)
echo "  Pre-test SHA:  $HEAD_SHA"
echo "  Post-test SHA: $POST_SHA"
if [ "$HEAD_SHA" = "$POST_SHA" ]; then
  echo "  ✅ SHA MATCH — tests ran against the claimed commit"
else
  echo "  ❌ SHA MISMATCH — working tree changed during tests!"
fi
echo "  Working tree clean: $(git status --porcelain | wc -l | tr -d ' ') uncommitted changes"

echo ""
echo "╔═══════════════════════════════════════════════════╗"
echo "║  EVIDENCE COMPLETE — Commit: $HEAD_SHA  ║"
echo "╚═══════════════════════════════════════════════════╝"
```

## Recording

```bash
chmod +x /tmp/<work_name>_evidence.sh

# Record with asciinema
asciinema rec /tmp/<work_name>.cast \
  --command "/tmp/<work_name>_evidence.sh" \
  --title "<descriptive title>" \
  --cols 120 --rows 50 \
  --overwrite

# Convert to GIF for embedding
agg --cols 120 --rows 50 --speed 3 \
  /tmp/<work_name>.cast \
  /tmp/<work_name>.gif
```

## Mandatory Evidence Sections

Every evidence video MUST include these sections in order:

| # | Section | Purpose |
|---|---------|---------|
| 1 | **Git Provenance** | `git rev-parse HEAD`, branch, merge-base — ties everything to a commit |
| 2 | **Commit Log** | `git log --oneline origin/main..HEAD` — shows what changed |
| 3 | **Code Diffs** | Actual `git diff` output, not just `--stat` — proves real changes |
| 4 | **PR/Issue Status** | `gh pr view` — links to the review artifact |
| 5 | **Live Tests** | Real `npm test` / `pytest` output — proves code works |
| 6 | **Post-test SHA** | Same `git rev-parse HEAD` after tests — proves no mid-run tampering |

## Anti-Patterns to Avoid

| ❌ Don't | ✅ Do Instead |
|----------|---------------|
| Show only `--stat` | Show actual `git diff` output |
| Skip SHA verification | Bookend with pre/post SHA |
| Hardcode "All tests pass" | Run real `npm test` live |
| Use `echo "PASS"` | Let real test runner output |
| Skip merge-base | Show `git merge-base HEAD origin/main` |

## Embedding in Walkthroughs

```markdown
![Evidence Demo](/path/to/evidence.gif)
```

Or for playback:
```bash
asciinema play /tmp/<work_name>.cast
```

## Reviewer Checklist

An agent reviewing this video should verify:

1. **SHA bookending**: Pre-test and post-test SHA match
2. **Real test output**: Not echoed/scripted results — real runner with timing
3. **Diffs shown**: Actual code changes visible, not just file names
4. **Zero FAIL lines**: All test suites PASS
5. **Clean working tree**: `0 uncommitted changes` at end
6. **Commit linkable**: SHA matches what's on the PR branch
