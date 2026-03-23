# Evidence Standards for All Testing and Verification

## Core Principle

**Evidence must prove what you claim.** Mock data cannot prove production behavior.

## Minimum Viable Evidence Checklist

**Every test MUST capture these at minimum (copy-paste into test setup):**

```python
def capture_provenance():
    """REQUIRED: Capture all evidence standards."""
    provenance = {}

    # === GIT PROVENANCE (MANDATORY) ===
    subprocess.run(["git", "fetch", "origin", "main"], timeout=10, capture_output=True)
    provenance["git_head"] = subprocess.check_output(
        ["git", "rev-parse", "HEAD"], text=True).strip()
    provenance["git_branch"] = subprocess.check_output(
        ["git", "branch", "--show-current"], text=True).strip()
    provenance["merge_base"] = subprocess.check_output(
        ["git", "merge-base", "HEAD", "origin/main"], text=True).strip()
    provenance["commits_ahead_of_main"] = int(subprocess.check_output(
        ["git", "rev-list", "--count", "origin/main..HEAD"], text=True).strip())
    provenance["diff_stat_vs_main"] = subprocess.check_output(
        ["git", "diff", "--stat", "origin/main...HEAD"], text=True).strip()

    # === SERVER RUNTIME (MANDATORY for server tests) ===
    port = BASE_URL.split(":")[-1].rstrip("/")
    pids = subprocess.check_output(
        ["lsof", "-i", f":{port}", "-t"], text=True).strip().split("\n")
    provenance["server"] = {
        "pid": pids[0] if pids else None,
        "port": port,
        "process_cmdline": subprocess.check_output(
            ["ps", "-p", pids[0], "-o", "command="], text=True).strip() if pids else None,
        "env_vars": {var: os.environ.get(var) for var in
            ["WORLDAI_DEV_MODE", "TESTING", "GOOGLE_APPLICATION_CREDENTIALS"]}
    }

    return provenance
```

**Quick validation:** If your metadata.json is missing ANY of these fields, the test is incomplete:
- `provenance.merge_base`
- `provenance.commits_ahead_of_main`
- `provenance.diff_stat_vs_main`
- `provenance.server.pid`
- `provenance.server.port`
- `provenance.server.process_cmdline`

## Three Evidence Rule (from CLAUDE.md)

**MANDATORY for ANY integration claim:**

1. **Configuration Evidence**: Show actual config file entries enabling the behavior
2. **Trigger Evidence**: Demonstrate automatic trigger mechanism (not manual execution)
3. **Log Evidence**: Timestamped logs from automatic behavior (not manual testing)

## Mock vs Real Mode Decision Tree

Before running ANY test, answer:

| Question | If YES → |
|----------|----------|
| Testing production/preview server behavior? | MUST use real mode |
| Validating actual API responses? | MUST use real mode |
| Checking data integrity (dice, state, persistence)? | MUST use real mode |
| Proving a bug is fixed in production? | MUST use real mode |
| Development workflow validation only? | Mock mode acceptable |
| Unit testing isolated functions? | Mock mode acceptable |

### Production Mode vs Real Mode

**Production mode is NOT required for valid evidence.** Local testing with real services
(real LLM APIs, real Firebase, real dice) is sufficient to prove behavior.
If a run artifact records `production_mode`, `production_mode: false` is acceptable
for evidence as long as the claim is not about production configuration or prod-only behavior.

| Mode | When to Use | Evidence Value |
|------|-------------|----------------|
| `--production-mode` | Final deployment validation | Highest (actual prod config) |
| `--evidence` (local server) | PR validation, feature proof | **Valid** (real APIs, real data) |
| Mock mode | Unit tests, CI speed | Invalid for behavior claims |

The key requirement is **real execution** (actual API calls, actual RNG), not production
environment. Evidence from `--start-local --evidence` is valid proof.

## Mock Mode Prohibition

**MOCK MODE = INVALID EVIDENCE** for:
- Production server validation
- API integration claims
- Data integrity verification (dice rolls, state changes)
- Bug fix confirmation
- Performance claims
- Security validation

**Mock mode tests ONLY prove:**
- Code syntax is correct
- Function signatures work
- Basic logic flow (in isolation)

**Mock mode tests NEVER prove:**
- Production behavior
- Real API responses
- Actual data execution
- Integration correctness

## Evidence Collection Requirements

### Canonical Evidence Bundle Files

**Required files in every evidence bundle:**

| File | Purpose | Required Keys |
|------|---------|---------------|
| `run.json` | Test results | `scenarios[*].name`, `scenarios[*].campaign_id`, `scenarios[*].errors` |
| `metadata.json` | Git/server provenance | `git_provenance`, `server`, `timestamp` |
| `evidence.md` | Human-readable summary | Pass/fail counts matching run.json |
| `methodology.md` | Test methodology | Environment, steps, validation |
| `README.md` | Package manifest | Git commit, branch, collection time |
| `request_responses.jsonl` | Raw MCP captures | Full request/response pairs |
| `llm_request_responses.jsonl` | Raw LLM request/response payloads | `type` field (`request` or `response`) |

**DEPRECATED:** `evidence.json` - use `run.json` + `metadata.json` instead.

**Required for base-class local-server traces:**
- `request_responses.jsonl` - MCP client ↔ local server (`/mcp`) request/response pairs
- `llm_request_responses.jsonl` - raw LLM-layer request/response capture stream

### Mandatory Scenarios Array

**Every test MUST emit `results["scenarios"]`** even for single-scenario runs:

```python
# ❌ BAD - Missing scenarios array causes "Total Scenarios: 0"
results = {"test_result": {...}}

# ✅ GOOD - Always include scenarios array
results = {
    "scenarios": [
        {
            "name": "scenario_name",
            "campaign_id": "abc123",  # Required for log traceability
            "passed": True,
            "errors": [],  # Always include, even if empty
            "checks": {...}
        }
    ],
    "test_result": {...}  # Optional summary
}
```

### Evidence Integrity (Checksums)

**ALL evidence files MUST have separate checksum files:**

```bash
# Generate checksums AFTER finalizing content
sha256sum run.json > run.json.sha256
sha256sum metadata.json > metadata.json.sha256

# Verify checksums
sha256sum -c run.json.sha256
```

**Anti-pattern:** Embedding checksums inside JSON files (self-invalidating).

**Checksum usability requirement:** `.sha256` files must reference the **local basename**
(e.g., `run.json`), not a nested path like `artifacts/run_.../run.json`.
This ensures `sha256sum -c` works when run from the evidence directory.

**ALL evidence files require checksums, including:**
- Individual test result files (PASS_*.json, FAIL_*.json)
- Aggregated files (request_responses.jsonl)
- Server logs (artifacts/server.log)

```python
def _write_checksum_for_file(filepath: Path) -> None:
    """Generate SHA256 checksum file for an existing file."""
    content = filepath.read_bytes()
    sha256_hash = hashlib.sha256(content).hexdigest()
    checksum_file = Path(str(filepath) + ".sha256")
    checksum_file.write_text(f"{sha256_hash}  {filepath.name}\n")
```

### Streaming Response Commitment (Signed Payload)

For integrations relying on streamed server output, done payload evidence must include:

- `streaming_response_signature.digest`
- `streaming_response_signature.algorithm`
- `streaming_response_signature.schema_version`
- `streaming_execution_trace`
- `request_id`

The signature is the SHA-256 digest (or HMAC-SHA256 when
`STREAM_RESPONSE_SIGNING_SECRET` is set) over canonical JSON for:

- `request_id`
- `response_text`
- `execution_trace`

Evidence reviewers (or replay scripts) must verify:

1. `streaming_response_signature` is present in real-mode runs.
2. `streaming_execution_trace` exists and records real provider path (`provider` / `mock_callable`) for phases.
3. In real mode, `mock_services_mode` is false and no phase uses `mock_local_fallback`.
4. `signature.verification` uses identical serialization (`sort_keys=True`, compact separators, UTF-8).

### Evidence Package Consistency (NEW)

**Single-run attribution:** If a bundle contains multiple runs, the docs **must**
name the exact run directory used for claims (e.g., `run_YYYYMMDD...`). Claims
must be traceable to one run only.

**Multi-campaign isolation:** If tests create multiple campaigns (e.g., isolated tests
for state-sensitive scenarios), evidence.md **must** include:
1. **Isolation Note** explaining why multiple campaigns exist
2. **Campaign ID** for each scenario result for traceability
3. **Claim Scoping** clarifying which campaign(s) aggregate claims reference

Example isolation note in evidence.md:
```markdown
## ⚠️ Multi-Campaign Isolation Note
This bundle contains **11 campaigns**: 1 shared + 10 isolated.
Each scenario includes its `campaign_id` for traceability.
```

**Per-scenario campaign ID in run.json:** When using fresh campaigns per scenario,
the test output **must** include `campaign_id` for each scenario entry:

```json
{
  "scenarios": [
    {
      "name": "Skill Check (Stealth)",
      "campaign_id": "zuFsywkYErTZpGBGDhDC",  // ← Required for log traceability
      "dice_audit_events": [...],
      "tool_results": [...]
    }
  ]
}
```

This enables matching server logs (which include `campaign_id=...`) to specific
scenario results in the evidence bundle.

**Doc ↔ data alignment:** Any item lists in methodology/evidence **must** be
derived from actual test inputs or `game_state_snapshot.json`. Hardcoded or
handwritten lists are invalid.

**Threshold capture:** If pass/fail depends on thresholds (e.g.,
`min_narrative_items`), those values must be recorded in `run.json` or the
methodology so reviewers can verify the criteria.

**Environment claims:** Only claim env vars that are read from the actual
environment during the run (or omit them).

**Unsupported claims:** CI status, Copilot analysis, or external validations
must include their own evidence artifacts, otherwise omit those claims.

**Bug-fix classification:** If a bundle labels a change as "new feature" to
avoid before/after evidence, it must include a justification. Otherwise, for
bug-fix claims, include a pre-fix reproduction and a post-fix run.

### Evidence Bundle Structure Requirements

**Claim → Artifact Map:** Every evidence.md MUST include a section mapping claims to files:

```markdown
## Claim → Artifact Map

| Claim | File | Key Field(s) |
|-------|------|--------------|
| DC set before roll (Gemini) | run.json | scenarios[].dice_audit_events[].dc_reasoning |
| DC set before roll (Qwen) | run.json | scenarios[].tool_results[].args.dc_reasoning |
| Executed code proof | gemini3_executed_code.log | dc = X before random.randint() |
```

**Coverage Matrix:** For multi-model or multi-scenario tests, include a summary table:

```markdown
## Coverage Matrix

| Scenario | Gemini 3 | Qwen | Key Params |
|----------|----------|------|------------|
| Attack Roll | Pass (dc=15) | Pass (ac=13) | AC-based |
| Skill Check | Pass (dc=13) | Pass (dc=13) | dc_reasoning required |
| Saving Throw | Pass (dc=15) | Pass (dc=17) | dc + dc_reasoning |
```

**Raw Response Retention:** Every scenario MUST have its raw LLM output saved:
- File pattern: `raw_{model}_{scenario}.txt`
- Contains unparsed LLM response for provenance

**Executed Code Capture (code_execution strategy):** When LLM uses code_execution:
- Log the exact Python code at INFO level
- Include campaign_id for traceability
- Show dc/dc_reasoning set BEFORE random.randint()

**Tool Request/Response Pairing (two-phase strategy):** When LLM uses tool calling:
- Capture full `args` (request) and `result` (response) together
- Temporal separation proven by: args sent → server generates roll → result returned

**Traceability Metadata:** Every evidence bundle MUST include:
- Run ID (timestamp-based: YYYYMMDD_HHMMSS)
- Per-scenario identifiers (campaign_id)
- Explicit statement tying log entries to scenarios

**Evidence Integrity Note:** Include a section documenting:
- Any scenarios with warnings or errors
- Where errors are recorded (even if empty: `"errors": []`)
- Overall pass/fail count

**What is NOT Proven (Exclusion List):** Explicitly state limitations:

```markdown
## What This Evidence Does NOT Prove

- Production server behavior (tested on local server)
- Performance under load (single-request tests)
- Edge cases not covered by scenarios (e.g., contested checks)
```

### Git Provenance Requirements

Every evidence bundle MUST capture:

```bash
git fetch origin main  # Ensure origin/main is current
git rev-parse HEAD     # Exact commit being tested
git rev-parse origin/main  # Base comparison point
git branch --show-current  # Branch name
git diff --name-only origin/main...HEAD  # Files changed
```

**Why:** Proves exactly what code was running during evidence capture.

### Server Environment Capture

For server-based evidence, capture:

```bash
# Process info
ps -eo pid,user,etime,args | grep "mvp_site\|python.*main"

# Listening ports
lsof -i :PORT -P -n | grep LISTEN

# Environment variables (sanitized)
# PID from above
lsof -p $PID 2>/dev/null | grep -E "^p|^fcwd|^n/"
```

**Required env vars to capture:**
- `WORLDAI_DEV_MODE`
- `PORT`
- `FIREBASE_PROJECT_ID`

### Evidence Directory Structure

**Canonical format with versioning (v1.1.0+):**

```
/tmp/<repo>/<branch>/<test_name>/
├── iteration_001/           # First test run
│   ├── README.md            # Package manifest with run_id, iteration
│   ├── README.md.sha256
│   ├── methodology.md       # Testing methodology documentation
│   ├── methodology.md.sha256
│   ├── evidence.md          # Evidence summary with metrics
│   ├── evidence.md.sha256
│   ├── notes.md             # Additional context, TODOs, follow-ups
│   ├── notes.md.sha256
│   ├── metadata.json        # Machine-readable: run_id, iteration, bundle_version
│   ├── metadata.json.sha256
│   ├── run.json             # Test results
│   ├── run.json.sha256
│   └── artifacts/           # Server logs, lsof, ps output
├── iteration_002/           # Second test run (auto-incremented)
│   └── ...
└── latest -> iteration_002  # Symlink to most recent
```

**Versioning Fields (REQUIRED in metadata.json):**

| Field | Description | Example |
|-------|-------------|---------|
| `bundle_version` | Evidence format version | `"1.1.0"` |
| `run_id` | Unique identifier for this run | `"llm_guardrails_exploits-003-20260101T221620"` |
| `iteration` | Run number within this test | `3` |

**Run ID Format:** `{test_name}-{iteration:03d}-{timestamp}`

Example metadata.json with versioning:
```json
{
  "test_name": "llm_guardrails_exploits",
  "run_id": "llm_guardrails_exploits-003-20260101T221620",
  "iteration": 3,
  "bundle_version": "1.1.0",
  "bundle_timestamp": "2026-01-01T22:16:20.000000+00:00",
  "provenance": { ... },
  "summary": { ... }
}
```

**Legacy format (still supported for backward compatibility):**

```
/tmp/<repo>/<branch>/<work>/<timestamp>/
├── README.md              # Package manifest with git provenance
├── README.md.sha256
├── methodology.md         # Testing methodology documentation
├── methodology.md.sha256
├── evidence.md            # Evidence summary with metrics
├── evidence.md.sha256
├── notes.md               # Additional context, TODOs, follow-ups
├── notes.md.sha256
├── metadata.json          # Machine-readable: git_provenance, timestamps
├── metadata.json.sha256
├── pr_diff.txt            # Optional (PR mode): full diff origin/main...HEAD
├── pr_diff_summary.txt    # Optional (PR mode): diff summary
└── artifacts/             # Copied evidence files (test outputs, logs, etc.)
    └── <copied files with checksums>
```

**Which flow to use?**

- **Automated (preferred):** When running `/generatetest` or automated test runners, rely on the built-in `save_evidence()` helper to produce metadata, README, and checksums in one pass.
- **Manual (shell-based):** Use when working in bare environments or ad-hoc investigations without the Python helper. The structure and required files remain the same; ensure metadata/README are created manually.

**Manual creation (shell-based):**
```bash
# Set up directory structure
REPO=$(basename $(git rev-parse --show-toplevel))
BRANCH=$(git rev-parse --abbrev-ref HEAD)
WORK="your-work-name"
TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
EVIDENCE_DIR="/tmp/${REPO}/${BRANCH}/${WORK}/${TIMESTAMP}"
mkdir -p "${EVIDENCE_DIR}/artifacts"

# Capture git provenance
git rev-parse HEAD > "${EVIDENCE_DIR}/git_head.txt"
git log -1 --format="%H%n%an <%ae>%n%aI%n%s" > "${EVIDENCE_DIR}/git_commit_info.txt"
git diff --name-only origin/main...HEAD > "${EVIDENCE_DIR}/changed_files.txt"

# Create package manifest and metadata to mirror automated flow
cat > "${EVIDENCE_DIR}/README.md" <<EOF
# Evidence Package Manifest
- Repository: ${REPO}
- Branch: ${BRANCH}
- Work Name: ${WORK}
- Collected At (UTC): ${TIMESTAMP}
EOF

cat > "${EVIDENCE_DIR}/metadata.json" <<EOF
{
  "repository": "${REPO}",
  "branch": "${BRANCH}",
  "work_item": "${WORK}",
  "timestamp": "${TIMESTAMP}",
  "created_by": "manual_shell_example"
}
EOF

# Create documentation files
echo "# Methodology" > "${EVIDENCE_DIR}/methodology.md"
echo "# Evidence Summary" > "${EVIDENCE_DIR}/evidence.md"
echo "# Notes" > "${EVIDENCE_DIR}/notes.md"

# Generate checksums
cd "${EVIDENCE_DIR}" || { echo "Failed to enter evidence directory" >&2; exit 1; }
shopt -s nullglob
for f in *.md *.txt *.json; do
  [ -f "$f" ] && sha256sum "$f" > "${f}.sha256"
done
shopt -u nullglob

# After populating methodology.md, evidence.md, and notes.md with real content,
# regenerate checksums to reflect the final state:
# for f in *.md *.txt *.json; do
#   [ -f "$f" ] && sha256sum "$f" > "${f}.sha256"
# done
```

**Alternative format** (still valid for specialized tests):

```
/tmp/{feature}_api_tests_v{N}/
├── full_evidence_transcript.txt   # Human-readable log
├── api_completion_test.json       # Structured test results
├── api_completion_test.json.sha256
├── post_process_analysis.json     # Validation/regression checks
├── post_process_analysis.json.sha256
└── evidence_capture.sh            # Reproducible script
```

### For Production Claims

Evidence MUST include:
- Real server URL (not localhost for production claims)
- Actual API responses with timestamps
- Real data from database/logs
- Specific values that prove execution (e.g., dice roll results)

### For Prompt Enforcement Claims

If you claim a specific system instruction or enforcement block was included in a live LLM call:
- Capture runtime prompt filenames (`debug_info.system_instruction_files`). Record `system_instruction_char_count` when available.
- Tie it to the same execution that produced the response (timestamp + request/response evidence)
- Static code references alone are insufficient

**Runtime Capture Mechanism (Your Project):**

```bash
# Start server (system instruction capture is always enabled)
CAPTURE_SYSTEM_INSTRUCTION_MAX_CHARS=120000 \
WORLDAI_DEV_MODE=true \
PORT=8005 \
python -m mvp_site.main serve
```

When enabled, full system instruction text appears in `debug_info.system_instruction_text` (optional).

**Prompt Tracking (default):**

Capture prompt filenames (and char count when available):
- `debug_info.system_instruction_files`: List of prompt files loaded (e.g., `["prompts/master_directive.md", "prompts/game_state_instruction.md"]`)
- `debug_info.system_instruction_char_count`: Total character count of combined prompts (optional)

This proves which prompts were used without the ~100KB overhead per response. The file list provides provenance while keeping evidence bundles manageable.

**Evidence Mode Documentation (MANDATORY when using lightweight tracking):**

When using lightweight prompt tracking, evidence files MUST include explicit documentation:

```json
{
  "evidence_mode": "lightweight_prompt_tracking",
  "evidence_mode_notes": "System instruction captured as filenames + char_count (not full text). Full raw_response_text from LLM is captured. Server logs in artifacts/."
}
```

This ensures reviewers know what capture approach was used and can assess evidence completeness accordingly.

### For Integration Claims

Evidence MUST show:
- Configuration enabling the integration
- Automatic triggering (not manual invocation)
- Logs proving automatic execution with timestamps

### For Bug Fix Claims

Evidence MUST include:
- Reproduction of original bug (before fix)
- Same scenario with fix applied
- Different outcome proving fix works

### For New Feature Claims

New features don't require "before" evidence since there's no prior behavior to compare.
Instead, prove:
- Feature works as specified (test results with pass/fail counts)
- Correct prompts/code were used (`system_instruction_files` or code paths)
- State changes correctly (game_state snapshots, database records)
### For LLM/API Behavior Claims

When proving LLM or API behavior, evidence MUST capture the full request/response cycle:

**Required captures:**
1. **Raw request payload** - The exact input sent to the API/LLM
2. **Raw response payload** - The exact output returned, before any parsing or transformation
3. **System instructions/prompts** - Prompt filenames; char count optional; full text only when explicitly requested
4. **Timestamps** - When each request was made and response received

**Mandatory 2-layer trace set for `testing_mcp/lib/base_test.py` runs:**
1. `request_responses.jsonl` - MCP client ↔ local server (`/mcp`) request/response pairs
2. `llm_request_responses.jsonl` (+ `artifacts/server.log`) - local server LLM handling traces

For base-class runs, these artifact files must be full and untrimmed.
When `REQUIRE_FULL_TRACE_LOGS=true`, missing/invalid trace artifacts are a hard failure.

**Why raw capture matters:**
- Parsed/transformed responses may hide LLM misbehavior
- System instruction files may differ from what was actually sent at runtime
- Summaries can mask edge cases or errors

**Capture format:**
```
request_responses.jsonl   # One JSON object per line, each containing:
{
  "timestamp": "ISO8601",
  "request": { ... full MCP request ... },
  "response": { ... full MCP response ... },
  "response.result.debug_info": {
    // Lightweight tracking (default):
    "system_instruction_files": ["prompts/master_directive.md", "..."],
    "system_instruction_char_count": 93180,
    // Full capture (when CAPTURE_SYSTEM_INSTRUCTION_MAX_CHARS > 0):
    "system_instruction_text": "system prompt sent to LLM",
    // Raw LLM capture (requires CAPTURE_RAW_LLM=true):
    "raw_request_payload": "full LLMRequest JSON sent to LLM (user action, context)",
    "raw_response_text": "LLM output before parsing"
  }
}
```

**Required debug_info fields for LLM claims:**
- `system_instruction_text` - The system prompt (captured by default)
- `raw_request_payload` - The user prompt/action sent to LLM (requires `CAPTURE_RAW_LLM=true`)
- `raw_response_text` - Raw LLM output before parsing (requires `CAPTURE_RAW_LLM=true`)

**Server configuration:**
- Enable full request/response logging in your server
- Set capture limits high enough to avoid truncation (e.g., 80K+ chars for LLM responses)
- Capture prompt filenames at runtime; full prompt text only when explicitly requested

**Default Evidence Capture:**

Raw LLM capture is **enabled by default** in the server (`$PROJECT_ROOT/llm_service.py`):
- `CAPTURE_RAW_LLM` defaults to `"true"` - no env var required
- Server default limit: 20,000 chars (sufficient for most use cases)

For tests needing higher limits, `server_utils.DEFAULT_EVIDENCE_ENV` provides overrides:

```python
DEFAULT_EVIDENCE_ENV = {
    "CAPTURE_RAW_LLM": "true",  # Server default, included for explicitness
    "CAPTURE_RAW_LLM_MAX_CHARS": "50000",  # Test override (server: 20000)
    "CAPTURE_SYSTEM_INSTRUCTION_MAX_CHARS": "120000",
}
```

This ensures raw request/response capture works automatically without manual configuration.

### For Test Result Portability

Test output files should be self-contained with embedded provenance:

```json
{
  "test_name": "feature_validation",
  "timestamp": "2025-12-27T05:00:00Z",
  "provenance": {
    "git_head": "abc123def456...",
    "git_branch": "feature-branch",
    "server_url": "http://localhost:8001"
  },
  "steps": [ ... ],
  "summary": { ... }
}
```

**Why embedded provenance:**
- Evidence bundle can be shared/moved without losing context
- Validates that test ran against claimed code version
- External provenance files can get separated from results

## Bulletproof Evidence Requirements (v3 Lessons)

These requirements elevate evidence from "probably correct" to "provably correct."

### Command Output with Exit Codes

**Assertions are not evidence.** Capture raw command output AND exit codes:

```bash
# ❌ BAD - Assertion only
echo "Fix commit is ancestor of test HEAD"

# ✅ GOOD - Raw output with exit code
echo "Command: git merge-base --is-ancestor $FIX_COMMIT $TEST_HEAD"
git merge-base --is-ancestor $FIX_COMMIT $TEST_HEAD
ANCESTRY_EXIT=$?
echo "Exit code: $ANCESTRY_EXIT"
echo "Interpretation: Exit 0 = TRUE (is ancestor), Exit 1 = FALSE (not ancestor), 128+ = error"
```

### Working Directory Anchor

**Every git command needs context.** Capture `pwd` to prove which repo:

```bash
echo "Working directory: $(pwd)"
echo "Git root: $(git rev-parse --show-toplevel)"
git rev-parse HEAD
```

### CI Checks Tied to HEAD SHA

**PR checks don't prove which commit was tested.** Link checks to specific SHA:

```bash
# Get the HEAD SHA being tested
HEAD_SHA=$(git rev-parse HEAD)

# Fetch check runs for that specific SHA
# Note: :owner/:repo is auto-inferred from git remote when run in a cloned repo
gh api repos/:owner/:repo/commits/$HEAD_SHA/check-runs \
  --jq '.check_runs[] | {name, status, conclusion, html_url}'
```

**Filter out placeholder checks:**
- Exclude checks with empty `html_url` or `completedAt = 0001-01-01T00:00:00Z`
- Exclude external links (e.g., `cursor.com`) that aren't GH Action runs

### Server-Process Git Linkage

**Server health ≠ server code version.** Tie gunicorn PID to its git state:

```bash
# Get gunicorn process listening on port 8005
PID=$(pgrep -f "gunicorn.*:8005" | head -1)

# Get its working directory (cross-platform)
if [ -L "/proc/$PID/cwd" ]; then
  SERVER_CWD=$(readlink -f "/proc/$PID/cwd")  # Linux
else
  SERVER_CWD=$(lsof -a -p "$PID" -d cwd 2>/dev/null | tail -1 | awk '{print $NF}')  # macOS
fi

# Verify git HEAD in server's working directory
git -C "$SERVER_CWD" rev-parse HEAD
```

### Timestamp Synchronization

**Spread-out timestamps break provenance chains.** Collect all evidence in one pass:

```bash
#!/bin/bash
# Single-pass evidence collection
TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EVIDENCE_DIR="/tmp/evidence_$(date +%s)"
mkdir -p "$EVIDENCE_DIR"

# Capture all state in rapid succession (< 60 seconds)
echo "Collection started: $TIMESTAMP" > "$EVIDENCE_DIR/log.txt"
curl -s http://localhost:8005/health >> "$EVIDENCE_DIR/server_state.txt"
git rev-parse HEAD >> "$EVIDENCE_DIR/git_state.txt"
# Run test
python test.py >> "$EVIDENCE_DIR/test_output.txt"
echo "Collection ended: $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$EVIDENCE_DIR/log.txt"
```

### Summary vs Raw Data Consistency

**Automated summaries must match raw data.** Always verify:

```bash
# If summary says "Copilot comments: 4"
# Raw data MUST show 4 entries with user.login matching
# Example: raw data shows .user.login == "Copilot" (not "github-copilot[bot]")

# ❌ BAD - Exact match misses variations
jq '[.[] | select(.user.login == "github-copilot[bot]")]'  # Misses "Copilot"

# ✅ GOOD - Case-insensitive pattern matching
jq '[.[] | select(.user.login | test("copilot"; "i"))]'
```

## Documentation-Data Alignment (Lessons from equipc Review)

When generating evidence documentation (methodology, evidence summary, notes), these rules prevent common mismatches:

### 1. Derive All Claims from Actual Data

**Never hardcode documentation content.** Generate it from source data:

```python
# ❌ BAD - Hardcoded claim
methodology = "WORLDAI_DEV_MODE=true"

# ✅ GOOD - Read from actual environment
dev_mode = os.environ.get("WORLDAI_DEV_MODE", "not set")
methodology = f"WORLDAI_DEV_MODE: {dev_mode}"
```

### 2. Warn on Missing/Dropped Data

**Silent drops hide real mismatches.** Track and report edge cases:

```python
# ❌ BAD - Silently skip missing items
items = [registry[id] for id in seeds if id in registry]

# ✅ GOOD - Track and warn
missing_ids = []
items = []
for id in seeds:
    if id in registry:
        items.append(registry[id])
    else:
        missing_ids.append(id)
if missing_ids:
    notes += f"WARNING: Missing IDs: {missing_ids}"
```

### 3. Display Denominators Must Match Totals

**"Found X/Y (need Z)" must use correct Y.** Common mistake: using min_required as denominator:

```python
# ❌ BAD - Misleading: "4/2 (need 2)" suggests 200% match
stats_col = f"{found}/{min_required} (need {min_required})"

# ✅ GOOD - Clear: "4/4 (need 2)" shows 4 of 4 found, 2 was minimum
stats_col = f"{found}/{len(total_required)} (need {min_required})"
```

### 4. Avoid Unverifiable Scope Claims

**Don't claim "bug fix" vs "new feature" unless explicit.** These are product decisions:

```python
# ❌ BAD - Makes unverifiable claim
methodology += "## New Feature (Not Bug Fix)\nThis is a new feature..."

# ✅ GOOD - Stick to verifiable facts
methodology += "## Test Scope\nValidates equipment display functionality."
```

### 5. Always Check Subprocess Return Codes

**Subprocess output alone doesn't prove success.** Check returncode:

```python
# ❌ BAD - Ignores failures
result = subprocess.run(cmd, capture_output=True)
print(result.stdout)

# ✅ GOOD - Warns on failure
result = subprocess.run(cmd, capture_output=True)
print(result.stdout)
if result.returncode != 0:
    print(f"WARNING: Command exited with code {result.returncode}")
```

### 6. Single Run Attribution

**Evidence bundles must reference exactly ONE test run.** Ambiguous artifact scope breaks traceability:

```python
# ❌ BAD - Copies entire directory with multiple runs
--artifact /path/to/all_runs/

# ✅ GOOD - Copies specific run only
--artifact /path/to/all_runs/run_20251227T051227_953691
```

## Pass Quality Classification

Not all passes are equal. Track evidence quality with explicit pass types:

| Pass Type | Criteria | Evidence Value |
|-----------|----------|----------------|
| **STRONG** | All conditions met with robust proof | Highest - conclusive |
| **WEAK** | Core requirement proven, secondary conditions not met | Valid but with caveats |
| **FAIL** | Core requirement not proven | Invalid |

**Example implementation:**
```python
# Track pass strength in evidence
strong_pass = primary_condition and secondary_condition
weak_pass = primary_condition and not secondary_condition
passed = primary_condition  # Core requirement

result = {
    "status": "PASS" if passed else "FAIL",
    "pass_type": "strong" if strong_pass else ("weak" if weak_pass else "fail"),
    ...
}
```

**Why this matters:**
- Weak passes prove the feature works but with less conclusive evidence
- Reviewers can assess confidence level from pass_type
- Follow-up tests can target "weak" areas for stronger proof

## Partial State Update Handling

APIs often return only changed fields. Tests MUST handle missing fields correctly:

```python
# ❌ BAD - Treats missing field as False
still_in_combat = response.get("combat_state", {}).get("in_combat") is True

# ✅ GOOD - Check field presence, use fallback logic
combat_state = response.get("combat_state", {})
if "in_combat" in combat_state:
    # Explicit value - use it
    still_in_combat = combat_state["in_combat"] is True
elif combat_state.get("current_round") is not None:
    # Partial update with round info - combat ongoing
    still_in_combat = True
else:
    # Fall back to previous state
    still_in_combat = previous_combat_state
```

**Common partial update scenarios:**
- Combat state updates: may include `current_round` but omit unchanged `in_combat`
- Character updates: may include `hp_current` but omit unchanged `level`
- Inventory updates: may include added item but not entire inventory

## Model Settings Forcing

**Always set explicit model settings** to avoid PROVIDER_SELECTION_NULL_SETTINGS fallback noise:

```python
from lib.model_utils import settings_for_model, update_user_settings

# ❌ BAD - Relies on server defaults, causes fallback noise in logs
result = process_action(client, user_id=user_id, campaign_id=campaign_id, ...)

# ✅ GOOD - Explicit model pinning before any actions
DEFAULT_MODEL = "gemini-3-flash-preview"

# Pin model settings at test start
update_user_settings(
    client,
    user_id=user_id,
    settings=settings_for_model(DEFAULT_MODEL),
)

# Now process actions with deterministic model selection
result = process_action(client, user_id=user_id, campaign_id=campaign_id, ...)
```

**Why this matters:**
- Eliminates "PROVIDER_SELECTION_NULL_SETTINGS" log noise
- Ensures reproducible behavior across test runs
- Makes evidence claims specific to a known model

## LLM Scenario Forcing

LLMs may "shortcut" scenarios by resolving them too quickly. Force extended scenarios when needed:

```python
# ❌ BAD - LLM may end combat in 1-2 actions
SCENARIO = "Fight three bandits"

# ✅ GOOD - Forces multi-round combat
SCENARIO = """You face an Ogre Warlord (CR 5, HP 120, AC 16) and two Ogre Guards (CR 2, HP 59 each).
This is a BOSS FIGHT - it CANNOT be resolved in fewer than 3 combat rounds.
DO NOT end combat prematurely. All enemies have full HP and fight to the death."""
```

**Forcing techniques:**
- High HP enemies (100+ HP for bosses)
- Explicit round count requirements
- "Fight to the death" instructions
- Multiple high-CR enemies

## Anti-Patterns

- **"Tests pass" without evidence type** - Mock tests passing ≠ production working
- **Health endpoint only** - Proves server is up, not that features work
- **Endpoint existence** - tools/list returning tools ≠ tools executing correctly
- **Assuming mock = real** - Mock data is fabricated; production data is evidence
- **Assertions without command output** - "Exit code 0" without showing the command
- **Timestamp gaps** - Server captured at T, test run at T+1hr breaks provenance
- **Summary/raw mismatch** - Automated counts that don't match raw data
- **Hardcoded env claims** - Claiming WORLDAI_DEV_MODE=true without reading os.environ
- **Silent data drops** - Skipping missing items without warning hides mismatches
- **Wrong denominators** - Display showing "4/2" when there are 4 total items

## When to Stop and Ask

If you're about to:
- Run mock mode for production validation → STOP, use real mode
- Claim "tests pass" without specifying mode → STOP, clarify mode
- Skip actual execution evidence → STOP, collect real evidence
- Trust health checks as feature validation → STOP, test actual features

## Self-Contained Evidence Files

Evidence JSON files must use **relative paths** for portability:

```json
// ❌ BAD - Absolute paths break when bundle is moved
{
  "artifacts_dir": "/tmp/worktree_worker7/dev123/e2e_test",
  "output_file": "/tmp/worktree_worker7/dev123/results.json"
}

// ✅ GOOD - Relative paths work anywhere
{
  "artifacts_dir": "./artifacts",
  "output_file": "./results.json"
}
```

**Post-processing requirement:** After copying test output into a bundle:
1. Validate all embedded paths are relative
2. If absolute paths exist, update them to be bundle-relative
3. Or document the original source location separately

## Single Checksum Layer

Evidence bundles must have **exactly one layer** of checksums:

| Strategy | When to Use |
|----------|-------------|
| Per-file `.sha256` | Simple bundles, few files |
| Root `checksums.sha256` | Complex bundles, many files |
| **NEVER both** | Causes `.sha256.sha256` pollution |

**When packaging artifacts that already have checksums:**

```bash
# Clean existing checksums before copying
find /path/to/source -name "*.sha256" -delete

# Then copy artifacts to bundle
cp -r /path/to/source "${EVIDENCE_DIR}/artifacts/"
```

**Manual cleanup alternative:**

```bash
# Remove all .sha256 files from artifact source before copying
find /path/to/source -name "*.sha256" -delete

# Then create fresh checksums at bundle level
cd /bundle/root
find . -type f ! -name "*.sha256" -exec sha256sum {} \; > checksums.sha256
```

## PR Mode for Full Diff Capture

When creating evidence for a PR, always capture the full diff from `origin/main`:

```bash
# ❌ AVOID - Last commit only (may miss PR context after merge)
git diff HEAD~1..HEAD

# ✅ PREFER - Full PR diff from origin/main
git diff origin/main...HEAD > "${EVIDENCE_DIR}/pr_diff.txt"
git diff --stat origin/main...HEAD > "${EVIDENCE_DIR}/pr_diff_summary.txt"
```

**Why this matters:**
- `HEAD~1..HEAD` captures only the last commit
- After merging main, this shows merge changes, not PR changes
- `origin/main...HEAD` always captures the full PR diff

## Runtime Behavior Evidence (Lessons from Memory Budget Testing)

### Inferential vs Direct Evidence

**Inferential evidence is insufficient.** "Action succeeded therefore truncation worked" is not proof.

```
# ❌ INFERENTIAL - Proves nothing about internal behavior
"budget_truncation_proof": "Action succeeded with memories exceeding budget = truncation worked"

# ✅ DIRECT - Runtime logs FROM THE CODE showing selection/exclusion
[MEMORY_BUDGET] Input: 605 memories, 43,816 tokens (budget: 40,000)
[MEMORY_BUDGET] TRUNCATED: 554 selected, 51 excluded, 39,959 tokens used
```

### Code Instrumentation for Evidence

When claiming internal behavior (truncation, filtering, deduplication), the code MUST produce logs that prove the behavior:

```python
# ❌ BAD - No evidence of truncation behavior
def select_memories_by_budget(memories, max_tokens):
    # ... selection logic ...
    return selected_memories

# ✅ GOOD - Runtime evidence captured in logs
def select_memories_by_budget(memories, max_tokens):
    logging_util.info(
        f"[MEMORY_BUDGET] Input: {len(memories)} memories, "
        f"{total_tokens:,} tokens (budget: {max_tokens:,})"
    )
    # ... selection logic ...
    logging_util.info(
        f"[MEMORY_BUDGET] TRUNCATED: {len(result)} selected, "
        f"{excluded_count} excluded, {final_tokens:,} tokens used"
    )
    return result
```

**Key principle:** If you can't point to a log line proving the behavior, add logging to produce that evidence.

### Server Logs During Test Execution

For any test claiming internal behavior:

1. Start server with logs captured to file
2. Run test against that server
3. Extract behavior proof from server logs
4. Include extracted proof as separate evidence file

```bash
# Start server with log capture
nohup python -m mvp_site.mcp_api --http-only --port 8003 > "$EVIDENCE_DIR/server_logs.txt" 2>&1 &

# Run tests against that server
python test.py --server-url http://127.0.0.1:8003

# Extract proof
grep "MEMORY_BUDGET" "$EVIDENCE_DIR/server_logs.txt" > "$EVIDENCE_DIR/memory_budget_proof.txt"
```

### Full Git Provenance Requirements

Beyond basic provenance, include:

```bash
cat > "$EVIDENCE_DIR/git_provenance_full.txt" << EOF
=== CURRENT STATE ===
Branch: $(git rev-parse --abbrev-ref HEAD)
Commit: $(git rev-parse HEAD)

=== COMMIT DETAILS ===
$(git log -1 --format="Author: %an <%ae>%nDate: %aI%nSubject: %s")

=== RECENT COMMITS ON BRANCH ===
$(git log --oneline -10)

=== ORIGIN/MAIN REFERENCE ===
origin/main: $(git rev-parse origin/main)

=== DIFF FROM ORIGIN/MAIN ===
$(git diff --stat origin/main...HEAD)

=== COMMITS AHEAD/BEHIND ===
Ahead: $(git rev-list --count origin/main..HEAD)
Behind: $(git rev-list --count HEAD..origin/main)

=== MODIFIED FILES ===
$(git diff --name-only origin/main...HEAD)
EOF
```

### Per-File Checksums (Preferred for Important Artifacts)

For key evidence files, use per-file checksums alongside the artifact:

```bash
# Generate per-file checksums
for file in server_logs.txt memory_budget_proof.txt server_env_capture.txt; do
    shasum -a 256 "$file" > "${file}.sha256"
done

# Results in:
# server_logs.txt
# server_logs.txt.sha256
# memory_budget_proof.txt
# memory_budget_proof.txt.sha256
```

**Why per-file:** Easier to verify individual artifacts; no need to parse a combined file.

## Related Standards

- `CLAUDE.md` - Three Evidence Rule (lines 110-113)
- `generatetest.toml` - Mock mode prohibition (lines 433-441)
- `end2end-testing.md` - Test mode commands (/teste, /tester, /testerc)
- `browser-testing-ocr-validation.md` - OCR evidence for visual claims
