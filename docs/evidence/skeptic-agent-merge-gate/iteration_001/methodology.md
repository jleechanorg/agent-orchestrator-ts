# Methodology — PR #206

## Test Environment

- **Node.js**: 20.x (via actions/setup-node@v4)
- **Package manager**: pnpm (via pnpm/action-setup@v4)
- **Lock file**: frozen (--frozen-lockfile)
- **Runner**: GitHub Actions (ubuntu-latest)

## Test Commands

### Core unit tests
```bash
pnpm -C packages/core test
```
- Vitest runner
- 51 test files
- 1005 tests total (including 10 new skeptic merge-gate tests)
- Result: ✅ All 1005 pass

### TypeScript build
```bash
pnpm build
```
- tsc compilation across all packages
- 0 TypeScript errors
- Result: ✅ SUCCESS

### ESLint
```bash
pnpm lint
```
- ESLint 10.x with TypeScript strict rules
- No `no-unused-vars` errors on skeptic.ts
- Result: ✅ SUCCESS

### Integration tests
```bash
pnpm test
```
- Full workspace test suite
- Result: ✅ SUCCESS

## Scope

This is a **unit test coverage** claim. The skeptic agent is a new CLI command that:
1. Fetches PR state via GitHub API
2. Runs an LLM-based evaluation via Claude CLI
3. Posts a verdict comment on the PR

The unit tests verify the merge-gate logic (not the CLI command itself, which requires GitHub API and Claude CLI access).

## New Skeptic Tests (10 tests)

`packages/core/src/__tests__/merge-gate-skeptic.test.ts`:
- skepticRequired=true, verdict=PASS → passes gate
- skepticRequired=true, verdict=FAIL → blocks merge
- skepticRequired=true, no verdict → blocks merge
- skepticRequired=false → skips skeptic check
- skepticBypassProjects includes current → skips skeptic
- Various edge cases

## Bug Fixes Applied

1. **Double query= prefix** (cursor/bugbot high): All 4 `gh api graphql` calls used `query={...}` inside `-f query=`, creating malformed double-prefix. Fixed: remove `query=` prefix from query strings.
2. **`gh repo --json` missing `view`** (cursor/bugbot high): `gh repo --json` is not valid. Fixed: `gh repo view --json`.
3. **`node:` prefix missing** (cursor/bugbot low): Dynamic `import("child_process")` should be `import("node:child_process")` in ESM.
4. **`user` vs `author`** (cursor/bugbot high): REST `/issues/N/comments` returns `user.login`; GraphQL reviewThreads returns `author.login`. Fixed: separate `IssueComment` (REST, user) from `ReviewThreadComment` (GraphQL, author).
