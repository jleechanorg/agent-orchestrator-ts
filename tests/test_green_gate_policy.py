"""Contract tests for the canonical two-gate Green Gate workflow."""

from pathlib import Path
import re


WORKFLOW = Path(__file__).resolve().parents[1] / ".github/workflows/green-gate.yml"


def workflow_text() -> str:
    return WORKFLOW.read_text()


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
        "CodeRabbit",
        "Bugbot clean",
        "reviewThreads",
        "Evidence format",
    )
    for marker in retired_markers:
        assert marker not in text, f"retired Green Gate logic remains: {marker}"


def test_ci_gate_is_current_head_and_excludes_itself():
    text = workflow_text()

    assert 'commits/"$HEAD_SHA"/check-runs' in text
    assert '.name != "Green Gate"' in text
    assert "CHECK_RUNS_PENDING" in text
    assert "CHECK_RUNS_FAILED" in text
    assert "STABLE_SUCCESS_SNAPSHOTS" in text
    assert "SUCCESS_SIGNATURE" in text


def test_merge_gate_retries_unknown_and_fails_closed():
    text = workflow_text()

    assert 'pulls/"$PR_NUM"' in text
    assert "Mergeability is still unknown; retrying" in text
    assert 'FAILED_GATES="${FAILED_GATES}2, "' in text


def test_result_is_bound_to_the_exact_head_sha():
    text = workflow_text()

    assert "green-gate-result-${HEAD_SHA}" in text
    assert "HEAD-SHA: ${HEAD_SHA}" in text


def test_green_gate_cannot_be_redirected_to_a_hosted_runner():
    text = workflow_text()

    assert "runs-on: [self-hosted]" in text
    assert "SELF_HOSTED_RUNNER_LABELS" not in text
