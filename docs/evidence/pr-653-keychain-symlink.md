# Evidence — PR #653 agent-antigravity keychain symlink fix

Fix commit: 9712e8e15 (+ test alignment 9af87d796). Verified on macOS (operator machine, 2026-06-04→05).

## CI-reproducible (unit tests)
`cd packages/plugins/agent-antigravity && npx vitest run` → **19 tests passed** (covers: always-symlink incl. headless mode, idempotent skip when correct target, recreate on wrong target, rmSync+symlink when path is a real dir, ENOENT skip).

Actual `npx vitest run` tail:

```
 RUN  v3.2.4 /Users/jleechan/.worktrees/agent-orchestrator/antig-keychain-symlink/packages/plugins/agent-antigravity

stdout | src/index.test.ts > antigravity getEnvironment > does not write to trustedFolders.json on parse failure to prevent clobbering
[antigravity] Failed to parse trustedFolders.json at /Users/mockuser/.ao-sessions/sess-1/.gemini/trustedFolders.json, skipping write to avoid clobbering: Expected property name or '}' in JSON at position 1 (line 1 column 2)
[antigravity] Failed to parse trustedFolders.json at /Users/mockuser/.gemini/trustedFolders.json, skipping write to avoid clobbering: Expected property name or '}' in JSON at position 1 (line 1 column 2)

stdout | src/index.test.ts > antigravity getEnvironment > skips writing global trustedFolders.json if lock acquisition times out to prevent clobbering
[antigravity] Lock acquisition timed out for /Users/mockuser/.gemini/trustedFolders.json, skipping write to avoid clobbering.

 ✓ src/index.test.ts (19 tests) 13ms

 Test Files  1 passed (1)
      Tests  19 passed (19)
   Start at  00:41:40
   Duration  697ms (transform 291ms, setup 0ms, collect 491ms, tests 13ms, environment 0ms, prepare 43ms)
```

Keychain/symlink-specific tests in the suite:
- `always symlinks Library/Keychains to the real user keychains on Darwin, even in headless mode` (index.test.ts:474)
- `does not recreate the symlink if it already exists and points to the correct target` (index.test.ts:496)
- `recreates the symlink if it points to an incorrect target` (index.test.ts:516)
- `removes a real directory and creates the symlink if the path exists but is not a symlink` (index.test.ts:539)
- `handles dangling symlinks and removes them before creating new ones` (index.test.ts:271)
- `handles symlink and unlink errors gracefully without throwing` (index.test.ts:298)

## Local operator verification (macOS `log show`, NOT CI-reproducible)
- After the symlink fix, antigravity/`agy` worker processes threw **ZERO** `errSecNoSuchKeychain (-25294)` in `log show --predicate 'subsystem == "com.apple.securityd"'` (the only -25294 in the window came from an UNRELATED GitHub Actions self-hosted runner: 863, attributed to `Runner.Listener`, not agy).
- Fresh AO sessions verified: `~/.ao-sessions/<id>/Library/Keychains` is a symlink → `/Users/jleechan/Library/Keychains`, and `HOME=<session-dir> security find-generic-password -l antigravity` resolves the OAuth token through the symlink.
- Actual macOS SecurityAgent dialog popups (the user-visible symptom) dropped to zero after the fix (measured via `log show --predicate 'process == "SecurityAgent"'` launch counts).

Note: the production metrics above are manual operator observations on the live machine and are not reproducible in CI; the authoritative automated evidence for this PR is the 19 passing unit tests.
