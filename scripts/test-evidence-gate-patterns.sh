#!/usr/bin/env bash
# bd-vidcap: regression tests for Terminal media / UI media video URL patterns
# shared by evidence-gate.yml and wholesome.yml (keep regexes in sync).
set -euo pipefail

pass() { echo "OK: $1"; }
fail() { echo "FAIL: $1" >&2; exit 1; }

# Mirrors evidence-gate / wholesome: terminal or UI block must contain a video-capable URL.
has_video_media_url() {
  local b="$1"
  if printf '%s' "$b" | grep -qiE 'https://[^[:space:]]+\.(mp4|gif|webm|mov)([/?#]|$)'; then return 0; fi
  if printf '%s' "$b" | grep -qiE 'https://github\.com/user-attachments/assets/[a-f0-9-]+'; then return 0; fi
  if printf '%s' "$b" | grep -qiE '!\[[^]]*\]\(https://[^)]+\.(mp4|gif|webm|mov)([?#)]|$)'; then return 0; fi
  return 1
}

has_tmux_caption() {
  local b="$1"
  printf '%s' "$b" | grep -qiE 'tmux|terminal'
}

# --- mp4 direct URL
b='**Terminal media**: https://cdn.example.com/clip.mp4
tmux session proof'
has_video_media_url "$b" || fail "mp4 URL should pass"
has_tmux_caption "$b" || fail "tmux caption"
pass "mp4 + tmux caption"

# --- GitHub user-attachments (no extension)
b='**Terminal media**: https://github.com/user-attachments/assets/abcd-ef12-3456-7890abcdef12
terminal recording'
has_video_media_url "$b" || fail "user-attachments URL should pass"
has_tmux_caption "$b" || fail "terminal caption"
pass "user-attachments + terminal caption"

# --- markdown image
b='**Terminal media**:
![rec](https://x.com/a.mp4)
tmux pane'
has_video_media_url "$b" || fail "markdown mp4 video"
has_tmux_caption "$b" || fail "tmux in caption"
pass "markdown video + tmux caption"

# --- reject bare PNG (screenshot)
b='**Terminal media**: https://x.com/s.png
tmux'
if has_video_media_url "$b"; then fail "png URL must not satisfy video requirement"; fi
pass "png rejected for video slot"

# --- reject bare https without video extension
b='**Terminal media**: https://example.com/path
tmux'
if has_video_media_url "$b"; then fail "bare URL without video pattern must fail"; fi
pass "non-video https rejected"

# --- query string on mp4
b='**Terminal media**: https://foo.com/x.mp4?token=abc
tmux'
has_video_media_url "$b" || fail "mp4 with query"
pass "mp4 with query string"

echo "All evidence-gate pattern tests passed."
