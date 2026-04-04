#!/usr/bin/env bash
# =============================================================================
# pr-media.sh — Capture tmux/terminal screenshot, upload to Gist, post as PR comment
#
# Implements Cursor-style evidence: screenshot of terminal with gist URL attached
# to the PR. Satisfies Evidence Bundle v2 "Terminal media" requirement.
#
# Usage:
#   bash scripts/pr-media.sh [--type screenshot|video|gif] [--pr N] [--caption "text"]
#   bash scripts/pr-media.sh --test          # dry-run: capture + upload, no PR comment
#
# Prerequisites:
#   - macOS screencapture (built-in: /usr/sbin/screencapture)
#   - gh gist create (GitHub CLI: brew install gh)
#   - gh authenticated: gh auth status
#   - PR exists: gh pr view N
#
# Output: prints markdown snippet to stdout for copy-paste into ## Evidence
# =============================================================================
set -euo pipefail

# ── colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; DIM='\033[2m'; RESET='\033[0m'

# ── defaults ────────────────────────────────────────────────────────────────
TYPE="${PR_MEDIA_TYPE:-screenshot}"
PR_NUM=""
CAPTION=""
DRY_RUN=false
OUT_DIR="${PR_MEDIA_OUT_DIR:-/tmp/pr-media}"
GIST_DESCRIPTION="AO PR Terminal Media — $(date '+%Y-%m-%d %H:%M')"
GIST_PUBLIC="${PR_MEDIA_PUBLIC:-false}"

# ── parse args ───────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --type)      TYPE="$2"; shift 2 ;;
    --pr)        PR_NUM="$2"; shift 2 ;;
    --caption)  CAPTION="$2"; shift 2 ;;
    --test)     DRY_RUN=true; shift ;;
    --help|-h)  echo "pr-media.sh — Capture tmux/terminal screenshot, upload to Gist"; exit 0 ;;
    *)           echo -e "${RED}Unknown flag: $1${RESET}"; exit 1 ;;
  esac
done

# ── helpers ─────────────────────────────────────────────────────────────────
info()    { echo -e "${CYAN}ℹ${RESET} $*"; }
success() { echo -e "${GREEN}✔${RESET} $*"; }
warn()    { echo -e "${YELLOW}⚠${RESET} $*"; }
fail()    { echo -e "${RED}✖${RESET} $*" >&2; }

timestamp() { date '+%Y%m%d_%H%M%S'; }

# ── pr detection ─────────────────────────────────────────────────────────────
detect_pr() {
  if [ -n "$PR_NUM" ]; then return; fi
  # Detect from current branch
  local branch
  branch=$(git branch --show-current 2>/dev/null || echo "")
  if [ -z "$branch" ]; then
    warn "Not in a git repo — cannot auto-detect PR number."
    return
  fi
  local pr_json
  pr_json=$(gh pr view --json number,title 2>/dev/null || echo "")
  if [ -n "$pr_json" ]; then
    # Use jq directly on the JSON output — do NOT pipe to 'gh api --jq' which
    # expects a REST endpoint, not stdin.
    PR_NUM=$(echo "$pr_json" | jq -r '.number')
    local pr_title
    pr_title=$(echo "$pr_json" | jq -r '.title')
    info "Detected PR: #$PR_NUM — $pr_title"
  else
    warn "No PR found for branch '$branch'. Use --pr N to specify."
  fi
}

# ── capture screenshot ───────────────────────────────────────────────────────
capture_screenshot() {
  local out="$OUT_DIR/screenshot_$(timestamp).png"
  mkdir -p "$OUT_DIR"

  # ── tmux pane capture ──────────────────────────────────────────────────────
  if [ -n "${TMUX:-}" ]; then
    info "Detected tmux session — capturing tmux pane"
    local pane_pid
    pane_pid=$(tmux display-message -p '#{pane_id}' 2>/dev/null || echo "")

    # Try picomgrab if available (captures specific tmux pane without select)
    if command -v picomgrab &>/dev/null; then
      info "Using picomgrab for tmux pane capture"
      if picomgrab -p "$pane_pid" "$out" 2>/dev/null; then
        success "Captured: $out"
        echo "$out"
        return
      fi
    fi

    # macOS screencapture: user selects window/area interactively
    # The -w flag waits for user selection (window mode)
    echo -e "${BOLD}${CYAN}→ Click the tmux/terminal window to capture (or Cmd+Shift+4 for area select)${RESET}"
    if screencapture -w -x "$out" 2>/dev/null && [ -f "$out" ] && [ -s "$out" ]; then
      success "Captured: $out"
      echo "$out"
      return
    fi
  fi

  # ── non-tmux fallback ───────────────────────────────────────────────────────
  warn "Not in tmux — capturing entire screen"
  local out_all="$OUT_DIR/screenshot_all_$(timestamp).png"
  if screencapture -x "$out_all" 2>/dev/null; then
    success "Captured full screen: $out_all"
    echo "$out_all"
    return
  fi

  fail "screencapture failed. Ensure Screen Recording permission is granted in System Preferences."
  exit 1
}

# ── capture video (ffmpeg) ───────────────────────────────────────────────────
capture_video() {
  local out="$OUT_DIR/recording_$(timestamp).mp4"
  mkdir -p "$OUT_DIR"

  if ! command -v ffmpeg &>/dev/null; then
    fail "ffmpeg not found. Install with: brew install ffmpeg"
    exit 1
  fi

  info "Starting 10-second screen recording (press Ctrl+C to stop)..."
  info "Recording will be saved to: $out"

  # Record display 1 (main screen) for 10 seconds
  if ffmpeg -f avfoundation \
             -capture_cursor 1 \
             -capture_mouse_clicks 1 \
             -i "1:none" \
             -t 10 \
             -c:v libx264 -preset ultrafast \
             "$out" 2>&1 | tail -5; then
    success "Recorded: $out"
    echo "$out"
  else
    fail "ffmpeg recording failed."
    exit 1
  fi
}

# ── capture gif (ffmpeg + gifski) ───────────────────────────────────────────
capture_gif() {
  local mp4_out="$OUT_DIR/recording_$(timestamp).mp4"
  local gif_out="${mp4_out%.mp4}.gif"
  mkdir -p "$OUT_DIR"

  if ! command -v ffmpeg &>/dev/null; then
    fail "ffmpeg not found. Install with: brew install ffmpeg"
    exit 1
  fi

  info "Recording 5-second clip for GIF conversion..."
  ffmpeg -f avfoundation \
         -capture_cursor 1 \
         -capture_mouse_clicks 1 \
         -i "1:none" \
         -t 5 \
         -c:v libx264 -preset ultrafast \
         "$mp4_out" 2>&1 | tail -3

  if [ ! -f "$mp4_out" ]; then
    fail "Video recording failed."
    exit 1
  fi

  if command -v gifski &>/dev/null; then
    info "Converting to GIF (this may take a moment)..."
    gifski -o "$gif_out" --fps 10 "$mp4_out" 2>/dev/null && {
      success "GIF created: $gif_out"
      rm -f "$mp4_out"
      echo "$gif_out"
      return
    }
    warn "gifski conversion failed, using MP4 instead"
  fi

  rm -f "$mp4_out"
  fail "GIF conversion failed."
  exit 1
}

# ── upload to gist ───────────────────────────────────────────────────────────
upload_gist() {
  local file="$1"
  local ext="${file##*.}"

  if [ ! -f "$file" ]; then
    fail "File not found: $file"
    exit 1
  fi

  # Check file size — Gist soft limit ~10MB, warn >5MB
  local size
  size=$(stat -f%z "$file" 2>/dev/null || stat -c%s "$file" 2>/dev/null || echo 0)
  local size_mb=$((size / 1024 / 1024))
  if [ "$size_mb" -gt 10 ]; then
    fail "File too large for Gist: ${size_mb}MB (max ~10MB)"
    exit 1
  elif [ "$size_mb" -gt 5 ]; then
    warn "Large file (${size_mb}MB). Consider compressing first."
  fi

  # Build filename
  local basename
  basename=$(basename "$file")
  local gist_name="${basename%.*}_$(timestamp).${ext}"

  info "Uploading to GitHub Gist..."
  local gist_url
  local public_flag
  # --public is a flag (no value); omit it for secret gists
  if [ "$GIST_PUBLIC" = "true" ]; then
    public_flag="--public"
  else
    public_flag=""
  fi
  gist_url=$(gh gist create "$file" \
    --desc "$GIST_DESCRIPTION" \
    $public_flag \
    2>&1) || {
    fail "gh gist create failed: $gist_url"
    exit 1
  }

  if [[ ! "$gist_url" =~ ^https://gist\.github\.com/ ]]; then
    fail "Unexpected gist URL: $gist_url"
    exit 1
  fi

  success "Uploaded: $gist_url"
  # P2 fix: echo only the URL to stdout — caller captures it as single-line value.
  echo "$gist_url"
}

# ── build markdown snippet ────────────────────────────────────────────────────
build_snippet() {
  local gist_url="$1"
  local media_type="$2"
  local file="$3"

  # Detect if this is tmux or general terminal
  local context_label="tmux pane"
  [ -z "${TMUX:-}" ] && context_label="terminal"

  # Build caption
  local caption="$CAPTION"
  if [ -z "$caption" ]; then
    local ts
    ts=$(date '+%Y-%m-%d %H:%M')
    caption="AO worker $context_label showing $(basename "$file") — captured $ts"
  fi

  # Infer media type label
  local media_label="screenshot"
  case "$media_type" in
    video) media_label="video recording" ;;
    gif)   media_label="GIF" ;;
  esac

  cat <<EOF

**Terminal media**: $gist_url
$context_label with $media_label — $caption
EOF
}

# ── post PR comment ──────────────────────────────────────────────────────────
post_pr_comment() {
  local pr="$1"
  local snippet="$2"

  if [ -z "$pr" ]; then
    warn "No PR number — skipping comment post."
    info "Snippet for manual paste:"
    echo "$snippet"
    return
  fi

  info "Posting to PR #$pr..."
  local body
  body=$(printf '## Terminal Media\n%s\n---\n*Captured by /pr-media*\n' "$snippet")

  gh pr comment "$pr" --body "$body" 2>&1 || {
    warn "gh pr comment failed — PR body update may be needed manually."
    info "Snippet:"
    echo "$snippet"
    return
  }

  success "Comment posted to PR #$pr"
}

# ── main ─────────────────────────────────────────────────────────────────────
main() {
  echo -e "${BOLD}${CYAN}pr-media${RESET} — Cursor-style terminal media capture"
  echo ""

  # Validate tools
  if ! command -v gh &>/dev/null; then
    fail "GitHub CLI (gh) not found. Install: brew install gh"
    exit 1
  fi

  if ! gh auth status &>/dev/null; then
    fail "GitHub CLI not authenticated. Run: gh auth login"
    exit 1
  fi

  if ! command -v screencapture &>/dev/null; then
    fail "screencapture not found (macOS only)"
    exit 1
  fi

  # Detect PR
  detect_pr

  # Capture
  local media_file=""
  case "$TYPE" in
    screenshot)
      media_file=$(capture_screenshot) ;;
    video)
      media_file=$(capture_video) ;;
    gif)
      media_file=$(capture_gif) ;;
    *)
      fail "Unknown type: $TYPE. Use: screenshot, video, or gif"
      exit 1 ;;
  esac

  # Upload
  local gist_url
  gist_url=$(upload_gist "$media_file")
  # Extract gist ID from URL (URL is the only line of output from upload_gist)
  local gist_id="${gist_url##*/}"

  # Build snippet
  local snippet
  snippet=$(build_snippet "$gist_url" "$TYPE" "$media_file")

  echo ""
  success "Done!"
  echo ""

  if [ "$DRY_RUN" = true ]; then
    info "Dry-run — not posting to PR"
    info "Gist URL: $gist_url"
    info "Gist raw URL: https://gist.githubusercontent.com/$gist_id/raw/$(basename "$media_file")"
    echo ""
  else
    post_pr_comment "$PR_NUM" "$snippet"
  fi

  echo ""
  echo -e "${BOLD}Markdown snippet for PR body:${RESET}"
  echo -e "${DIM}(copy everything below this line into ## Evidence)${RESET}"
  echo "─────────────────────────────────────────"
  echo "$snippet"
  echo "─────────────────────────────────────────"
  echo ""
  echo -e "${GREEN}Gist:     $gist_url${RESET}"
  echo -e "${GREEN}Raw URL:  https://gist.githubusercontent.com/$gist_id/raw/$(basename "$media_file")${RESET}"
}

main
