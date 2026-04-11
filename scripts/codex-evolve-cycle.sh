#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

REPORT_DIR="${REPORT_DIR:-/tmp/codex-evolve-cycle-$(date +%Y%m%d-%H%M%S)}"
CHECK_TIMEOUT_SECONDS="${CHECK_TIMEOUT_SECONDS:-45}"
APPEND_ROADMAP="${APPEND_ROADMAP:-0}"
ROADMAP_FILE="${ROADMAP_FILE:-$REPO_ROOT/roadmap/evolve-loop-findings.md}"

mkdir -p "$REPORT_DIR"

run_capture() {
  local name="$1"
  shift
  local out="$REPORT_DIR/${name}.out"
  local status="$REPORT_DIR/${name}.status"
  local rc=0
  if timeout --foreground "$CHECK_TIMEOUT_SECONDS" "$@" >"$out" 2>&1; then
    rc=0
  else
    rc=$?
  fi
  echo "$rc" >"$status"
}

run_capture shell "bash" "-lc" "tmux list-sessions -F '#{session_name}' 2>/dev/null"
run_capture ao_doctor ao doctor
run_capture ao_status ao status
run_capture openclaw_status openclaw status
run_capture open_prs gh api "repos/jleechanorg/agent-orchestrator/pulls?state=open&per_page=100"
run_capture merged_prs gh api "repos/jleechanorg/agent-orchestrator/pulls?state=closed&per_page=100&sort=updated&direction=desc"
run_capture sessions ao session ls --project agent-orchestrator
run_capture coverage bash "$REPO_ROOT/scripts/check-pr-worker-coverage.sh"

TMUX_FILE="$REPORT_DIR/shell.out"
PANES_FILE="$REPORT_DIR/tmux-panes.txt"
: >"$PANES_FILE"
while IFS= read -r sess; do
  [[ "$sess" =~ ^([a-f0-9]+-)?(ao|jc|wa|wc|cc|ra)-[0-9]+$ ]] || continue
  {
    echo "=== $sess ==="
    tmux capture-pane -t "$sess" -p 2>/dev/null | tail -30
    echo
  } >>"$PANES_FILE"
done <"$TMUX_FILE"

OPEN_PRS_JSON="$REPORT_DIR/open_prs.out"
SESSIONS_TEXT="$REPORT_DIR/sessions.out"
STATUS_TEXT="$REPORT_DIR/ao_status.out"
MERGED_PRS_JSON="$REPORT_DIR/merged_prs.out"
COVERAGE_TEXT="$REPORT_DIR/coverage.out"

python3 - "$OPEN_PRS_JSON" "$SESSIONS_TEXT" "$STATUS_TEXT" "$MERGED_PRS_JSON" "$COVERAGE_TEXT" "$REPORT_DIR/summary.json" "$REPORT_DIR/summary.md" <<'PY'
import datetime as dt
import json
import re
import sys
from pathlib import Path

open_prs_path, sessions_path, status_path, merged_path, coverage_path, summary_json_path, summary_md_path = map(Path, sys.argv[1:])

open_prs = json.loads(open_prs_path.read_text() or "[]")
sessions_text = sessions_path.read_text()
status_text = status_path.read_text()
merged_prs = json.loads(merged_path.read_text() or "[]")
coverage_text = coverage_path.read_text()


def extract_agent_orchestrator_rows(raw_status: str) -> list[str]:
    rows: list[str] = []
    in_project = False
    saw_body = False
    for line in raw_status.splitlines():
        if "agent-orchestrator fork" in line:
            in_project = True
            continue
        if not in_project:
            continue
        if saw_body and line.startswith("┌"):
            break
        if not line.strip():
            continue
        if line.startswith("└") or line.startswith("│"):
            continue
        if "Session       Branch" in line or set(line.strip()) == {"─"}:
            continue
        if re.match(r"^\s+[a-z]+-\d+", line):
            rows.append(line)
            saw_body = True
    return rows


def parse_coverage(raw_coverage: str) -> tuple[list[int], list[int], dict[int, str]]:
    covered: list[int] = []
    uncovered: list[int] = []
    blocked_reasons: dict[int, str] = {}
    current_pr: int | None = None
    for line in raw_coverage.splitlines():
        pr_match = re.match(r"^\s*PR #(\d+) \[.*\]: age=", line)
        if pr_match:
            current_pr = int(pr_match.group(1))
            continue
        if current_pr is None:
            continue
        if "-> covered by session" in line:
            covered.append(current_pr)
            current_pr = None
            continue
        if "-> BLOCKED recent claim_failed:" in line:
            blocked_reasons[current_pr] = line.split("-> BLOCKED recent claim_failed:", 1)[1].strip()
            uncovered.append(current_pr)
            current_pr = None
            continue
        if "-> UNCOVERED" in line or "-> no active session" in line:
            uncovered.append(current_pr)
            current_pr = None
            continue
    return sorted(set(covered)), sorted(set(uncovered)), blocked_reasons

session_branch_map = {}
session_prs = set()
stuck_prs = set()
session_re = re.compile(r"^\s*([a-z]+-\d+)\s+\([^)]*\)\s+([^\[]+?)\s+\[(\w+)\](?:\s+https://api\.github\.com/repos/[^/]+/[^/]+/pulls/(\d+))?\s*$")
for line in sessions_text.splitlines():
    m = session_re.match(line)
    if not m:
        continue
    sid, branch, state, pr = m.groups()
    branch = branch.strip()
    session_branch_map[branch] = sid
    if pr:
        session_prs.add(int(pr))
        if state == "stuck":
            stuck_prs.add(int(pr))

covered_prs, uncovered_prs, blocked_reasons = parse_coverage(coverage_text)
blocked_prs = sorted(blocked_reasons)

project_rows = extract_agent_orchestrator_rows(status_text)
activity_by_pr: dict[int, str] = {}
unknown_sessions: list[str] = []
status_row_re = re.compile(
    r"^\s+([a-z]+-\d+)\s+\S+\s+(?:#(\d+)|-)\s+\S+\s+\S+\s+\S+\s+(unknown|ready|working|idle)\s+.+$"
)
for row in project_rows:
    m = status_row_re.match(row)
    if not m:
        continue
    session_id, pr_num, activity = m.groups()
    if activity == "unknown":
        unknown_sessions.append(session_id)
    if pr_num:
        activity_by_pr[int(pr_num)] = activity

idle_prs = sorted(pr for pr, activity in activity_by_pr.items() if activity == "idle")
working_prs = sorted(pr for pr, activity in activity_by_pr.items() if activity == "working")
ready_prs = sorted(pr for pr, activity in activity_by_pr.items() if activity == "ready")
stuck_prs = sorted(set(idle_prs) | stuck_prs)

now = dt.datetime.now(dt.timezone.utc)
merged_last_24h = []
for pr in merged_prs:
    merged_at = pr.get("merged_at")
    if not merged_at:
        continue
    merged_dt = dt.datetime.fromisoformat(merged_at.replace("Z", "+00:00"))
    if (now - merged_dt).total_seconds() <= 24 * 3600:
        merged_last_24h.append(pr)

auto_merged = [pr for pr in merged_last_24h if (pr.get("merged_by") or {}).get("login") == "github-actions[bot]"]
zero_touch_rate = 0.0
if merged_last_24h:
    zero_touch_rate = len(auto_merged) / len(merged_last_24h)

primary_issue = None
if stuck_prs:
    primary_issue = f"Stuck worker PRs: {', '.join('#'+str(n) for n in stuck_prs[:6])}"
elif blocked_prs:
    primary_issue = f"Claim-blocked PRs: {', '.join('#'+str(n) for n in blocked_prs[:6])}"
elif idle_prs:
    primary_issue = f"Idle worker PRs: {', '.join('#'+str(n) for n in idle_prs[:6])}"
elif uncovered_prs:
    primary_issue = f"Uncovered open PRs: {', '.join('#'+str(n) for n in uncovered_prs[:6])}"
elif unknown_sessions:
    primary_issue = f"Sessions with unknown activity: {', '.join(unknown_sessions[:6])}"
else:
    primary_issue = "No single dominant friction point found"

summary = {
    "generated_at": now.isoformat(),
    "open_pr_count": len(open_prs),
    "covered_prs": covered_prs,
    "uncovered_prs": uncovered_prs,
    "blocked_prs": blocked_prs,
    "blocked_reasons": blocked_reasons,
    "idle_prs": idle_prs,
    "stuck_prs": stuck_prs,
    "working_prs": working_prs,
    "ready_prs": ready_prs,
    "unknown_session_count": len(unknown_sessions),
    "local_phases_completed": ["observe", "measure", "diagnose", "record"],
    "zero_touch_rate": zero_touch_rate,
    "merged_last_24h": len(merged_last_24h),
    "auto_merged_last_24h": len(auto_merged),
    "primary_issue": primary_issue,
}

summary_json_path.write_text(json.dumps(summary, indent=2) + "\n")

lines = [
    f"## Codex Evolve Cycle — {now.strftime('%Y-%m-%d %H:%M UTC')}",
    f"- Open PRs: {len(open_prs)}",
    f"- Covered PRs: {len(covered_prs)}",
    f"- Uncovered PRs: {len(uncovered_prs)}",
    f"- Blocked PRs: {', '.join('#'+str(n) for n in blocked_prs) if blocked_prs else 'none'}",
    f"- Idle PRs: {', '.join('#'+str(n) for n in idle_prs) if idle_prs else 'none'}",
    f"- Stuck PRs: {', '.join('#'+str(n) for n in stuck_prs) if stuck_prs else 'none'}",
    f"- Ready PRs: {', '.join('#'+str(n) for n in ready_prs) if ready_prs else 'none'}",
    f"- Working PRs: {', '.join('#'+str(n) for n in working_prs) if working_prs else 'none'}",
    f"- Unknown session count: {len(unknown_sessions)}",
    f"- Local phases completed: observe, measure, diagnose, record",
    f"- Zero-touch rate (last 24h): {len(auto_merged)}/{len(merged_last_24h)} ({zero_touch_rate:.0%})" if merged_last_24h else "- Zero-touch rate (last 24h): no merged PRs",
    f"- Primary friction: {primary_issue}",
]
if uncovered_prs:
    lines.append(f"- Uncovered PR numbers: {', '.join('#'+str(n) for n in uncovered_prs)}")
if blocked_prs:
    for pr_num in blocked_prs[:5]:
        lines.append(f"- Blocked detail #{pr_num}: {blocked_reasons[pr_num]}")
summary_md_path.write_text("\n".join(lines) + "\n")
print(summary_md_path.read_text(), end="")
PY

if [ "$APPEND_ROADMAP" = "1" ]; then
  cat >>"$ROADMAP_FILE" <<EOF

$(cat "$REPORT_DIR/summary.md")
EOF
fi

echo
echo "ARTIFACTS:"
echo "  report_dir=$REPORT_DIR"
echo "  summary_json=$REPORT_DIR/summary.json"
echo "  summary_md=$REPORT_DIR/summary.md"
echo "  tmux_panes=$PANES_FILE"
