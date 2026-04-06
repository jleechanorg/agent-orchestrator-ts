#!/usr/bin/env bash
# bd-vidcap: regression tests for Terminal media URL extraction + known-pattern detection
# (keep in sync with .github/workflows/evidence-gate.yml and wholesome.yml).
set -euo pipefail

pass() { echo "OK: $1"; }
fail() { echo "FAIL: $1" >&2; exit 1; }

extract_first_https() {
  printf '%s' "$1" | grep -oE 'https://[^[:space:])>]+' | head -1 | sed 's/[.,;]*$//'
}

# Mirrors evidence-gate "KNOWN_TM" check for TM_FIRST_URL.
tm_first_url_known() {
  local u="$1"
  [ -n "$u" ] || return 1
  if printf '%s' "$u" | grep -qiE '\.(mp4|gif|cast|webm|mov)([/?#]|$)'; then return 0; fi
  if printf '%s' "$u" | grep -qiE 'gist\.github\.com'; then return 0; fi
  if printf '%s' "$u" | grep -qiE 'asciinema\.org'; then return 0; fi
  if printf '%s' "$u" | grep -qiE 'github\.com/user-attachments/assets/'; then return 0; fi
  return 1
}

has_tmux_caption() {
  printf '%s' "$1" | grep -qiE 'tmux|terminal'
}

# --- mp4
b='**Terminal media**: https://cdn.example.com/clip.mp4
tmux session proof'
u=$(extract_first_https "$b")
[ -n "$u" ] || fail "extract mp4"
tm_first_url_known "$u" || fail "mp4 should be known pattern"
has_tmux_caption "$b" || fail "tmux caption"
pass "mp4 + tmux caption"

# --- user-attachments
b='**Terminal media**: https://github.com/user-attachments/assets/abcd-ef12-3456-7890abcdef12
terminal recording'
u=$(extract_first_https "$b")
tm_first_url_known "$u" || fail "user-attachments should be known"
pass "user-attachments"

# --- .cast
b='**Terminal media**: https://gist.github.com/user/abc/raw/foo.cast
tmux'
u=$(extract_first_https "$b")
tm_first_url_known "$u" || fail ".cast should be known"
pass "gist .cast URL"

# --- asciinema
b='**Terminal media**: https://asciinema.org/a/499990
terminal'
u=$(extract_first_https "$b")
tm_first_url_known "$u" || fail "asciinema should be known"
pass "asciinema"

# --- unknown HTTPS (bd-vidcap: WARN in CI, not FAIL)
b='**Terminal media**: https://cdn.example.com/screen.png
tmux'
u=$(extract_first_https "$b")
if tm_first_url_known "$u"; then fail "png host should be unknown pattern"; fi
pass "png URL triggers unknown-pattern path (warn-only in gate)"

# --- markdown image mp4
b='**Terminal media**:
![rec](https://x.com/a.mp4)
tmux pane'
u=$(extract_first_https "$b")
tm_first_url_known "$u" || fail "markdown mp4"
pass "markdown image mp4"

echo "All evidence-gate pattern tests passed."
