# Evidence Summary — llm-inspector on-demand stub-schema

## Verdict: PASS

**Claim class**: Terminal/CLI integration test (real HTTP through proxy to mock upstream)
**Date**: 2026-04-11
**Test runner**: test-real-upstream.mjs
**Runs**: 10 iterations (N=10)

## What Makes This "Real"

- Actual HTTP POST through the proxy to a real TCP server
- Realistic Claude Code Agent tool schema used as input (1368 bytes, 8 properties)
- Mock upstream captures EXACT bytes forwarded by proxy
- Stub substitution proven by parsing actual upstream request body

## Test Results

| Test | Result |
|------|--------|
| all 10 runs: Agent stubbed, Bash preserved | ✅ PASS |

## Statistical Summary (N=10)

| Metric | Value |
|--------|-------|
| Mean reduction | 84.9% |
| Std dev | 0.0% |
| Min | 84.9% |
| Max | 84.9% |
| Pass rate | 10/10 |

## Evidence Details

```json
[
  {
    "test": "real upstream stub substitution",
    "pass": true,
    "original_agent_bytes": 1368,
    "stubbed_agent_bytes": 206,
    "reduction_percent": "84.9",
    "stub_description": "Spawn an autonomous sub-agent to handle a task.",
    "agent_stub_has_task_property": true,
    "bash_preserved": true,
    "total_upstream_bytes": 552,
    "total_original_bytes": 1714,
    "total_reduction_percent": "67.8"
  },
  {
    "test": "real upstream stub substitution",
    "pass": true,
    "original_agent_bytes": 1368,
    "stubbed_agent_bytes": 206,
    "reduction_percent": "84.9",
    "stub_description": "Spawn an autonomous sub-agent to handle a task.",
    "agent_stub_has_task_property": true,
    "bash_preserved": true,
    "total_upstream_bytes": 552,
    "total_original_bytes": 1714,
    "total_reduction_percent": "67.8"
  },
  {
    "test": "real upstream stub substitution",
    "pass": true,
    "original_agent_bytes": 1368,
    "stubbed_agent_bytes": 206,
    "reduction_percent": "84.9",
    "stub_description": "Spawn an autonomous sub-agent to handle a task.",
    "agent_stub_has_task_property": true,
    "bash_preserved": true,
    "total_upstream_bytes": 552,
    "total_original_bytes": 1714,
    "total_reduction_percent": "67.8"
  },
  {
    "test": "real upstream stub substitution",
    "pass": true,
    "original_agent_bytes": 1368,
    "stubbed_agent_bytes": 206,
    "reduction_percent": "84.9",
    "stub_description": "Spawn an autonomous sub-agent to handle a task.",
    "agent_stub_has_task_property": true,
    "bash_preserved": true,
    "total_upstream_bytes": 552,
    "total_original_bytes": 1714,
    "total_reduction_percent": "67.8"
  },
  {
    "test": "real upstream stub substitution",
    "pass": true,
    "original_agent_bytes": 1368,
    "stubbed_agent_bytes": 206,
    "reduction_percent": "84.9",
    "stub_description": "Spawn an autonomous sub-agent to handle a task.",
    "agent_stub_has_task_property": true,
    "bash_preserved": true,
    "total_upstream_bytes": 552,
    "total_original_bytes": 1714,
    "total_reduction_percent": "67.8"
  },
  {
    "test": "real upstream stub substitution",
    "pass": true,
    "original_agent_bytes": 1368,
    "stubbed_agent_bytes": 206,
    "reduction_percent": "84.9",
    "stub_description": "Spawn an autonomous sub-agent to handle a task.",
    "agent_stub_has_task_property": true,
    "bash_preserved": true,
    "total_upstream_bytes": 552,
    "total_original_bytes": 1714,
    "total_reduction_percent": "67.8"
  },
  {
    "test": "real upstream stub substitution",
    "pass": true,
    "original_agent_bytes": 1368,
    "stubbed_agent_bytes": 206,
    "reduction_percent": "84.9",
    "stub_description": "Spawn an autonomous sub-agent to handle a task.",
    "agent_stub_has_task_property": true,
    "bash_preserved": true,
    "total_upstream_bytes": 552,
    "total_original_bytes": 1714,
    "total_reduction_percent": "67.8"
  },
  {
    "test": "real upstream stub substitution",
    "pass": true,
    "original_agent_bytes": 1368,
    "stubbed_agent_bytes": 206,
    "reduction_percent": "84.9",
    "stub_description": "Spawn an autonomous sub-agent to handle a task.",
    "agent_stub_has_task_property": true,
    "bash_preserved": true,
    "total_upstream_bytes": 552,
    "total_original_bytes": 1714,
    "total_reduction_percent": "67.8"
  },
  {
    "test": "real upstream stub substitution",
    "pass": true,
    "original_agent_bytes": 1368,
    "stubbed_agent_bytes": 206,
    "reduction_percent": "84.9",
    "stub_description": "Spawn an autonomous sub-agent to handle a task.",
    "agent_stub_has_task_property": true,
    "bash_preserved": true,
    "total_upstream_bytes": 552,
    "total_original_bytes": 1714,
    "total_reduction_percent": "67.8"
  },
  {
    "test": "real upstream stub substitution",
    "pass": true,
    "original_agent_bytes": 1368,
    "stubbed_agent_bytes": 206,
    "reduction_percent": "84.9",
    "stub_description": "Spawn an autonomous sub-agent to handle a task.",
    "agent_stub_has_task_property": true,
    "bash_preserved": true,
    "total_upstream_bytes": 552,
    "total_original_bytes": 1714,
    "total_reduction_percent": "67.8"
  }
]
```

## What This Evidence Proves

- Proxy stubbed Agent schema in all 10 runs (mean 84.9% reduction: 1368B → 206B)
- Bash tool preserved unchanged in all runs
- Real HTTP request/response through the full proxy→upstream chain
- Stub uses correct `input_schema` format with `task` property

## What This Evidence Does NOT Prove

- Full SSE re-issue flow (requires live Claude API with tool_use response)
- Token savings in a real Claude Code session

## Claim -> Artifact Map

| Claim | Artifact | Notes |
|-------|----------|-------|
| Agent stubbed in all runs | `artifacts/run.json` | Parsed from real upstream bytes, N=10 |
| Mean 84.9% reduction | `artifacts/run.json` | 1368B → 206B, N=10 |
| Bash preserved in all runs | `artifacts/run.json` | bash_preserved: true for all runs |
| Real HTTP through proxy | `artifacts/collection_log.txt` | Console output from test run |
| Test script source | `artifacts/test-real-upstream.mjs` | Preserved raw artifact |