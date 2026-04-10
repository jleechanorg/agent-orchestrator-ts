#!/usr/bin/env bash
# Regression tests for scripts/novel/run-daily.sh
#
# Run: bash tests/unit/test-run-daily.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SOURCE_SCRIPT="$SCRIPT_DIR/scripts/novel/run-daily.sh"

PASS=0
FAIL=0

assert_exit() {
  local label="$1" got="$2" expected="$3"
  if [[ "$got" == "$expected" ]]; then
    printf "  PASS  %s\n" "$label"
    PASS=$((PASS + 1))
  else
    printf "  FAIL  %s\n        got exit: %s\n        expected: %s\n" "$label" "$got" "$expected"
    FAIL=$((FAIL + 1))
  fi
}

assert_contains() {
  local label="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    printf "  PASS  %s\n" "$label"
    PASS=$((PASS + 1))
  else
    printf "  FAIL  %s\n        missing: %s\n" "$label" "$needle"
    FAIL=$((FAIL + 1))
  fi
}

make_fake_bin_dir() {
  local bin_dir="$1"

  cat >"$bin_dir/git" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

repo_root="${FAKE_REPO_ROOT:?}"

if [[ "${1:-}" == "-C" ]]; then
  cwd="$2"
  shift 2
else
  cwd="$PWD"
fi

if [[ -n "${FAKE_GIT_LOG_FILE:-}" ]]; then
  printf '%s\n' "$*" >>"$FAKE_GIT_LOG_FILE"
fi

case "$*" in
  "rev-parse --abbrev-ref HEAD")
    echo "main"
    ;;
  "status --porcelain --untracked-files=all")
    ;;
  "fetch origin main")
    ;;
  "merge --ff-only origin/main")
    ;;
  "log --since="*)
    echo "abc123 [agento] test commit"
    ;;
  "rev-parse --short HEAD")
    echo "abc1234"
    ;;
  *)
    echo "unexpected git args: $* (cwd=$cwd repo_root=$repo_root)" >&2
    exit 1
    ;;
esac
EOF

  cat >"$bin_dir/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

case "$*" in
  "pr list --state open --json number,title,updatedAt --limit 10 --jq .[] | \"#\\(.number): \\(.title)\""|"pr list --state merged --json number,title,mergedAt --limit 10 --jq .[] | \"#\\(.number): \\(.title)\""|"run list --limit 10 --json name,status,conclusion,workflowName --jq .[] | \"\\(.workflowName): \\(.conclusion || .status)\"")
    printf '%s\n' "${FAKE_GH_STDOUT:-}"
    exit 0
    ;;
  *)
    echo "unexpected gh args: $*" >&2
    exit 1
    ;;
esac
EOF

  cat >"$bin_dir/ao" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "spawn" ]]; then
  if [[ "$#" -ne 6 || "${2:-}" != "-p" || "${3:-}" != "agent-orchestrator" || "${4:-}" != "--runtime" || "${5:-}" != "tmux" || -z "${6:-}" ]]; then
    echo "unexpected ao spawn args: $*" >&2
    exit 1
  fi
  if [[ -n "${FAKE_SPAWN_PROMPT_FILE:-}" ]]; then
    printf '%s\n' "${6}" >"$FAKE_SPAWN_PROMPT_FILE"
  fi
  if [[ -n "${FAKE_SPAWN_MARKER:-}" ]]; then
    : >"$FAKE_SPAWN_MARKER"
  fi
  printf 'Creating session...\n' >&2
  printf 'SESSION=fake-session\n'
  exit 0
fi

if [[ "${1:-}" == "status" && "${2:-}" == "--json" ]]; then
  if [[ "${FAKE_WRITE_DAILY:-0}" == "1" ]]; then
    printf 'worker prose\n' >"$FAKE_DAILY_FILE"
  fi
  if [[ "${FAKE_WRITE_WORKERS:-0}" == "1" ]]; then
    printf '%s\nworker prose\n' "$FAKE_TODAY_HEADER" >"$FAKE_WORKERS_FILE"
  fi
  printf '[{"name":"fake-session","status":"%s"}]\n' "${FAKE_SESSION_STATUS:?}"
  exit 0
fi

echo "unexpected ao args: $*" >&2
exit 1
EOF

  cat >"$bin_dir/jq" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" != "-r" || "${2:-}" != *'select(.name == "fake-session") | .status'* ]]; then
  echo "unexpected jq args: $*" >&2
  exit 1
fi

input="$(cat)"
if [[ "$input" != *'"name":"fake-session"'* || "$input" != *'"status":"'${FAKE_SESSION_STATUS:?}'"'* ]]; then
  echo "unexpected jq input: $input" >&2
  exit 1
fi

printf '%s\n' "${FAKE_SESSION_STATUS:?}"
EOF

  cat >"$bin_dir/date" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "+%Y-%m-%d" ]]; then
  printf '%s\n' "${FAKE_TODAY:?}"
  exit 0
fi

exec /bin/date "$@"
EOF

  chmod +x "$bin_dir/git" "$bin_dir/gh" "$bin_dir/ao" "$bin_dir/jq" "$bin_dir/date"
}

run_case() {
  local label="$1" status="$2" write_daily="$3" write_workers="$4" expected_exit="$5" expected_text="$6"
  local precreate_artifacts="${7:-0}" expect_spawn="${8:-1}"
  local tmp_dir repo_root bin_dir today today_header daily_file workers_file spawn_marker git_log_file git_log output rc

  tmp_dir="$(mktemp -d)"
  repo_root="$tmp_dir/repo"
  bin_dir="$tmp_dir/bin"
  mkdir -p "$repo_root/scripts/novel" "$repo_root/novel/workers" "$bin_dir"
  cp "$SOURCE_SCRIPT" "$repo_root/scripts/novel/run-daily.sh"
  chmod +x "$repo_root/scripts/novel/run-daily.sh"
  make_fake_bin_dir "$bin_dir"

  today="2026-04-10"
  today_header="## Daily ${today}"
  daily_file="$repo_root/novel/workers/${today}.md"
  workers_file="$repo_root/novel/the-daily-lives-of-workers.md"
  spawn_marker="$tmp_dir/spawned"
  git_log_file="$tmp_dir/git.log"
  : >"$workers_file"

  if [[ "$precreate_artifacts" == "1" ]]; then
    printf 'existing daily entry\n' >"$daily_file"
    printf '%s\nexisting worker prose\n' "$today_header" >"$workers_file"
  fi

  set +e
  output="$(
    PATH="$bin_dir:$PATH" \
    FAKE_REPO_ROOT="$repo_root" \
    FAKE_SESSION_STATUS="$status" \
    FAKE_WRITE_DAILY="$write_daily" \
    FAKE_WRITE_WORKERS="$write_workers" \
    FAKE_DAILY_FILE="$daily_file" \
    FAKE_WORKERS_FILE="$workers_file" \
    FAKE_TODAY_HEADER="$today_header" \
    FAKE_TODAY="$today" \
    FAKE_GIT_LOG_FILE="$git_log_file" \
    FAKE_SPAWN_MARKER="$spawn_marker" \
    bash "$repo_root/scripts/novel/run-daily.sh" 2>&1
  )"
  rc=$?
  set -e

  assert_exit "$label exit" "$rc" "$expected_exit"
  assert_contains "$label output" "$output" "$expected_text"
  if [[ "$expect_spawn" == "0" ]]; then
    if [[ ! -e "$spawn_marker" ]]; then
      printf "  PASS  %s\n" "$label no spawn"
      PASS=$((PASS + 1))
    else
      printf "  FAIL  %s\n        unexpected ao spawn invocation\n" "$label no spawn"
      FAIL=$((FAIL + 1))
    fi
  else
    if [[ -e "$spawn_marker" ]]; then
      printf "  PASS  %s\n" "$label spawn invoked"
      PASS=$((PASS + 1))
    else
      printf "  FAIL  %s\n        expected ao spawn invocation\n" "$label spawn invoked"
      FAIL=$((FAIL + 1))
    fi
  fi
  if [[ "$expect_spawn" == "0" ]]; then
    git_log="$(cat "$git_log_file" 2>/dev/null || true)"
    assert_contains "$label sync fetch" "$git_log" "fetch origin main"
    assert_contains "$label sync merge" "$git_log" "merge --ff-only origin/main"
  fi

  rm -rf "$tmp_dir"
}

echo ""
echo "=== run-daily spawn/status contract ==="
run_case \
  "cleanup status succeeds via SESSION= parsing" \
  "cleanup" \
  "1" \
  "1" \
  "0" \
  "Success: Daily novel entry"
run_case \
  "killed status fails fast" \
  "killed" \
  "0" \
  "0" \
  "1" \
  "failed with status: killed"
run_case \
  "errored status fails fast" \
  "errored" \
  "0" \
  "0" \
  "1" \
  "failed with status: errored"
run_case \
  "final validation requires workers header" \
  "cleanup" \
  "1" \
  "0" \
  "1" \
  "Workers file"
run_case \
  "idempotent no-op when artifacts exist" \
  "cleanup" \
  "0" \
  "0" \
  "0" \
  "already exists; nothing to do." \
  "1" \
  "0"

echo ""
echo "Results: PASS=$PASS FAIL=$FAIL"

if [[ $FAIL -eq 0 ]]; then
  echo "OK — run-daily handles SESSION= parsing, cleanup terminal status, killed failure, and dual-artifact validation."
  exit 0
fi

echo "UNEXPECTED — run-daily regression detected."
exit 1
