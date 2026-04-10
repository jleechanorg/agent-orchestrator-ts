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
  # Start at the URL line so inline captions on the same line as the URL are accepted,
  # matching the workflow logic in evidence-gate.yml and wholesome.yml.
  local b="$1"
  local url_line
  url_line=$(printf '%s' "$b" | grep -n 'https://' | head -1 | cut -d: -f1)
  printf '%s' "$b" \
    | tail -n +"${url_line:-1}" \
    | grep -v '^[[:space:]]*$' \
    | grep -v '^[[:space:]]*```' \
    | awk '{ sub(/^\*\*Terminal media\*\*:[[:space:]]*/, ""); sub(/^\*\*Terminal media\*\* :[[:space:]]*/, ""); print }' \
    | grep -qiE 'tmux|terminal'
}

ui_video_url_allowed() {
  local b="$1"
  if printf '%s' "$b" | grep -qiE 'https://[^[:space:]]+\.(mp4|gif|webm|mov)([/?#]|$)'; then return 0; fi
  if printf '%s' "$b" | grep -qiE 'https://github\.com/user-attachments/assets/[a-f0-9-]+'; then return 0; fi
  if printf '%s' "$b" | grep -qiE '!\[[^]]*\]\(https://[^)]+\.(mp4|gif|webm|mov)([?#)]|$)'; then return 0; fi
  return 1
}

ui_media_url_allowed() {
  local b="$1"
  if printf '%s' "$b" | grep -qiE 'https://[^[:space:]]+\.(png|jpg|jpeg|gif|webp|mp4|webm|mov)([/?#]|$)'; then return 0; fi
  if printf '%s' "$b" | grep -qiE '!\[[^]]*\]\(https://[^)]+\.(png|jpg|jpeg|gif|webp|mp4|webm|mov)([?#)]|$)'; then return 0; fi
  return 1
}

claim_floor_matches_code_change() {
  printf '%s\n' "$1" | grep -qiE '\.(ts|js|jsx|tsx|py|go|sh|json|cjs|mjs|vue|svelte)$'
}

has_caption_marker() {
  printf '%s' "$1" | grep -qiE 'caption'
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

# --- inline URL + caption on same line
b='**Terminal media**: https://cdn.example.com/inline.mp4 tmux pane capture'
u=$(extract_first_https "$b")
tm_first_url_known "$u" || fail "inline mp4"
has_tmux_caption "$b" || fail "inline caption"
pass "inline URL caption"

# --- frontend UI video with caption
b='**UI media**: https://cdn.example.com/flow.webm?download=1
Caption: video of the updated React flow'
ui_video_url_allowed "$b" || fail "frontend webm video"
has_caption_marker "$b" || fail "frontend caption marker"
pass "frontend UI video + caption"

# --- frontend UI png should be rejected
b='**UI media**: https://cdn.example.com/flow.png
Caption: screenshot only'
if ui_video_url_allowed "$b"; then fail "frontend png should not satisfy UI video rule"; fi
pass "frontend UI png rejected"

# --- non-frontend screenshot fallback with caption
b='**UI media**: https://cdn.example.com/flow.png
Caption: screenshot of CLI settings page'
ui_media_url_allowed "$b" || fail "non-frontend screenshot fallback"
has_caption_marker "$b" || fail "non-frontend caption marker"
pass "non-frontend screenshot + caption"

# --- non-frontend media without caption stays incomplete
b='**UI media**: https://cdn.example.com/flow.mov'
ui_media_url_allowed "$b" || fail "non-frontend mov fallback"
if has_caption_marker "$b"; then fail "caption should be required for UI media"; fi
pass "UI media still requires caption"

# --- claim floor treats frontend source files as code changes
claim_floor_matches_code_change $'src/app.tsx\nsrc/ui/Widget.vue\nsrc/ui/Panel.svelte' || fail "claim floor should match frontend source extensions"
pass "claim floor matches frontend source extensions"

# --- claim floor ignores docs-only diffs
if claim_floor_matches_code_change $'docs/guide.md\nassets/mockup.png'; then fail "claim floor should ignore docs-only diffs"; fi
pass "claim floor ignores docs-only diffs"

echo "All evidence-gate pattern tests passed."
