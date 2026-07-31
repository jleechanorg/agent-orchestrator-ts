"""Contract tests for the canonical two-gate Green Gate workflow."""

from pathlib import Path
import json
import os
import re
import subprocess
import textwrap

import pytest


WORKFLOW = Path(__file__).resolve().parents[1] / ".github/workflows/green-gate.yml"
EXPECTED_HEAD_SHA = "1" * 40


def workflow_text() -> str:
    return WORKFLOW.read_text()


def workflow_step(name: str) -> str:
    text = workflow_text()
    start = text.index(f"      - name: {name}")
    run_start = text.index("        run: |\n", start) + len("        run: |\n")
    next_step = text.find("\n      - name:", run_start)
    end = len(text) if next_step == -1 else next_step
    return textwrap.dedent(text[run_start:end])


def run_gate(
    tmp_path: Path,
    contexts: list[dict],
    *,
    live_head: str = EXPECTED_HEAD_SHA,
    graphql_exit: int = 0,
) -> tuple[subprocess.CompletedProcess[str], str, int | None]:
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    fake_gh = fake_bin / "gh"
    fake_gh.write_text(
        """#!/usr/bin/env bash
set -u
if [[ "${2:-}" == "graphql" ]]; then
  if [[ "${GRAPHQL_EXIT:-0}" != "0" ]]; then
    exit "$GRAPHQL_EXIT"
  fi
  printf '%s\n' "$ROLLUP_JSON"
  exit 0
fi
if [[ "${2:-}" == "repos/jleechanorg/agent-orchestrator-ts/pulls/777" ]]; then
  printf '%s\n' "$PR_JSON"
  exit 0
fi
printf '%s\n' '{}'
"""
    )
    fake_gh.chmod(0o755)
    fake_sleep = fake_bin / "sleep"
    fake_sleep.write_text("#!/usr/bin/env bash\nexit 0\n")
    fake_sleep.chmod(0o755)

    gate = workflow_step("Run two-gate checks")
    gate = gate.replace(
        "${{ github.repository }}", "jleechanorg/agent-orchestrator-ts"
    )
    output = tmp_path / "github-output"
    output.write_text("")
    env = {
        **os.environ,
        "PATH": f"{fake_bin}:{os.environ['PATH']}",
        "PR_NUM": "777",
        "EXPECTED_HEAD_SHA": EXPECTED_HEAD_SHA,
        "GITHUB_OUTPUT": str(output),
        "GRAPHQL_EXIT": str(graphql_exit),
        "PR_JSON": json.dumps(
            {
                "head": {"sha": live_head},
                "mergeable": True,
                "mergeable_state": "clean",
                "merged": False,
            }
        ),
        "ROLLUP_JSON": json.dumps(
            [
                {
                    "data": {
                        "repository": {
                            "object": {
                                "statusCheckRollup": {
                                    "contexts": {"nodes": contexts}
                                }
                            }
                        }
                    }
                }
            ]
        ),
    }
    result = subprocess.run(
        ["bash", "-c", gate],
        check=False,
        capture_output=True,
        text=True,
        env=env,
    )
    overall = next(
        (
            line.split("=", 1)[1]
            for line in output.read_text().splitlines()
            if line.startswith("overall=")
        ),
        "",
    )
    if not overall:
        return result, overall, None

    final = workflow_step("Set check result")
    final_result = subprocess.run(
        ["bash", "-c", final],
        check=False,
        capture_output=True,
        text=True,
        env={**env, "OVERALL": overall},
    )
    return result, overall, final_result.returncode


def test_green_gate_has_exactly_two_result_rows():
    text = workflow_text()

    assert "Deterministic 2-Gate Check" in text
    rows = re.findall(r'GATE_ROWS=.*?\|\s+(\d+)\.\s+([^|]+)\|', text)
    assert rows == [("1", "CI green "), ("2", "No conflicts ")]


def test_only_ci_and_mergeability_can_fail_green():
    text = workflow_text()

    retired_markers = (
        "6-green",
        "Gate 3",
        "Gate 4",
        "Gate 5",
        "Gate 6",
        "CR approved",
        "CodeRabbit approval",
        "CodeRabbit review",
        "Bugbot clean",
        "reviewThreads",
        "Evidence format",
    )
    for marker in retired_markers:
        assert marker not in text, f"retired Green Gate logic remains: {marker}"


def test_ci_gate_is_current_head_and_excludes_itself():
    text = workflow_text()

    assert "statusCheckRollup" in text
    assert "StatusContext" in text
    assert "CheckRun" in text
    assert ".state" in text
    assert ".conclusion" in text
    assert '.name != "Green Gate"' in text
    assert "CHECK_RUNS_PENDING" in text
    assert "CHECK_RUNS_FAILED" in text
    assert "STABLE_SUCCESS_SNAPSHOTS" in text
    assert "SUCCESS_SIGNATURE" in text
    assert '.context != "CodeRabbit"' in text
    assert '(.checkSuite.app.slug // "") != "coderabbitai"' in text


def test_merge_gate_retries_unknown_and_fails_closed():
    text = workflow_text()

    assert 'pulls/"$PR_NUM"' in text
    assert "Mergeability is still unknown; retrying" in text
    assert 'FAILED_GATES="${FAILED_GATES}2, "' in text


def test_result_is_bound_to_the_exact_head_sha():
    text = workflow_text()

    assert 'if [ "$EXPECTED_HEAD_SHA" != "$HEAD_SHA" ]; then' in text
    assert "exit 1" in text
    assert "green-gate-result-${HEAD_SHA}" in text
    assert "HEAD-SHA: ${HEAD_SHA}" in text


def test_green_gate_cannot_be_redirected_to_a_hosted_runner():
    text = workflow_text()

    assert "runs-on: [self-hosted]" in text
    assert "SELF_HOSTED_RUNNER_LABELS" not in text


def check_run(status: str, conclusion: str | None) -> dict:
    return {
        "__typename": "CheckRun",
        "name": "unit-tests",
        "status": status,
        "conclusion": conclusion,
        "startedAt": "2026-07-31T00:00:00Z",
        "checkSuite": {"app": {"slug": "github-actions"}},
    }


def status_context(state: str) -> dict:
    return {
        "__typename": "StatusContext",
        "context": "legacy-ci",
        "state": state,
        "createdAt": "2026-07-31T00:00:00Z",
    }


@pytest.mark.parametrize(
    ("contexts", "graphql_exit", "expected_overall"),
    [
        ([check_run("COMPLETED", "SUCCESS"), status_context("SUCCESS")], 0, "PASS"),
        ([], 0, "FAIL"),
        ([check_run("IN_PROGRESS", None), status_context("SUCCESS")], 0, "FAIL"),
        ([check_run("COMPLETED", "FAILURE"), status_context("SUCCESS")], 0, "FAIL"),
        ([check_run("COMPLETED", "CANCELLED"), status_context("SUCCESS")], 0, "FAIL"),
        ([check_run("COMPLETED", "SUCCESS"), status_context("PENDING")], 0, "FAIL"),
        ([check_run("COMPLETED", "SUCCESS"), status_context("FAILURE")], 0, "FAIL"),
        ([check_run("COMPLETED", "SUCCESS")], 1, "FAIL"),
    ],
)
def test_rollup_union_fails_closed(
    tmp_path, contexts, graphql_exit, expected_overall
):
    first, overall, final_rc = run_gate(
        tmp_path, contexts, graphql_exit=graphql_exit
    )

    assert first.returncode == 0
    assert overall == expected_overall
    assert final_rc == (0 if expected_overall == "PASS" else 1)


def test_moved_head_exits_before_polling(tmp_path):
    moved_head = "f" * 40
    first, overall, final_rc = run_gate(
        tmp_path,
        [check_run("COMPLETED", "SUCCESS"), status_context("SUCCESS")],
        live_head=moved_head,
    )

    assert first.returncode != 0
    assert overall == ""
    assert final_rc is None
    assert "stale" in (first.stdout + first.stderr).casefold()
    assert "if: always() && steps.gates.outputs.comment_body != ''" in workflow_text()
