# Methodology — llm-inspector on-demand stub-schema real integration test

## What was tested

Real integration test of the proxy's `--tool-mode on-demand` stub substitution behavior.

## Test approach

1. **Start mock upstream TCP server** on port 19998 that captures all received bytes
2. **Start the proxy** on port 19999 with `--tool-mode on-demand --upstream http://127.0.0.1:19998`
3. **Send a real HTTP POST** to the proxy with a realistic Claude Code Agent tool schema (1368 bytes, 8 properties)
4. **Parse the upstream bytes** to verify Agent was stubbed and Bash was preserved
5. **Calculate reduction**: 1368B original → 206B stub = 84.9% reduction on Agent tool

## Why this is "real"

- Actual HTTP request through the proxy to a real TCP server
- Realistic schema (not a mock) — multi-property Agent tool with enums, nested objects
- The mock upstream receives and logs the EXACT bytes the proxy forwarded
- Verified by parsing the actual upstream request body

## Evidence collected

- `artifacts/test-real-upstream.mjs`: Test script
- `artifacts/run.json`: Machine-readable test results
- `artifacts/collection_log.txt`: Console output from the test run

## Limitations

- N=10 iterations (2026-04-11) — performance figures are averages across 10 independent runs; stddev=0.0% because the system is deterministic (same input, same stub substitution each run); this demonstrates consistent behavior across process spawns, not statistical sampling of a variable system
- Each iteration creates fresh server/process instances (no persistent connection state between runs): 2500ms proxy startup wait, 500ms post-request wait, 200ms inter-iteration delay
- Mock upstream server (not a real Claude API) — verifies stub substitution but not end-to-end API response
- Does not test SSE re-issue flow (requires live streaming API)
- Does not measure actual token count savings via API

## Claim class

Terminal/CLI integration test — lower rigor than production monitoring but stronger than unit test because it exercises the full proxy HTTP chain.
