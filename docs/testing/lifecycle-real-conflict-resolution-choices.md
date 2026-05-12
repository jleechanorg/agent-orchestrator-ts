# Lifecycle Conflict Resolution Choices

This document records the resolution choices for PR 545.

## Conflict

The PR started with an add/add conflict on `docs/testing/lifecycle-real-conflict-resolution.md`.
The temporary base branch and PR head branch both added the same file path with different body text.

## Resolution

The resolved fixture preserves both sides:

- The base-side lifecycle observation language was kept.
- The head-side conflict repair language was kept.
- The file was normalized under one `# Lifecycle Real Conflict Resolution Fixture` heading.

This keeps the PR useful as a lifecycle test while making the branch mergeable.
