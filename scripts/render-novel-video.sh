#!/usr/bin/env bash
# render-novel-video.sh — Render AO novel as MP4 and upload to Drive
# Usage: bash scripts/render-novel-video.sh [--dry-run] [--force]
#
# Reads:  novel/the-daily-lives-of-workers.md
# Outputs: remotion/out/daily-lives-of-workers.mp4
# Uploads: Google Drive via gog

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || echo "$SCRIPT_DIR")"
NOVEL_FILE="$REPO_DIR/novel/the-daily-lives-of-workers.md"
REMOTION_DIR="$REPO_DIR/remotion"
ROOT_TSX="$REMOTION_DIR/src/Root.tsx"
OUTPUT_MP4="$REMOTION_DIR/out/daily-lives-of-workers.mp4"
TEMPLATE_TSX="$SCRIPT_DIR/.render-template.tsx"

DRY_RUN=false
FORCE=false
if [[ "${1:-}" == "--dry-run" ]]; then DRY_RUN=true; fi
if [[ "${1:-}" == "--force" ]]; then FORCE=true; fi

log()  { echo "  [render-novel] $*"; }
step() { echo ""; echo "=== $*"; }
ok()   { echo "  ✅ $*"; }

# ─── 1. Validate ────────────────────────────────────────────────────────────
step "Validating environment"

if [[ ! -f "$NOVEL_FILE" ]]; then
  echo "ERROR: novel file not found: $NOVEL_FILE" >&2
  exit 1
fi
ok "Novel file: $NOVEL_FILE ($(wc -c < "$NOVEL_FILE") bytes)"

if ! command -v gog &>/dev/null; then
  echo "ERROR: gog CLI not found. Install: brew install steipete/tap/gogcli" >&2
  exit 1
fi
ok "gog CLI available"

# Check gog auth
GOG_ACCOUNT=$(gog auth list 2>/dev/null | grep drive | awk '{print $1}' | head -1 || echo "")
if [[ -z "$GOG_ACCOUNT" ]]; then
  echo "ERROR: gog not authenticated for Drive. Run: gog auth add you@gmail.com --services drive" >&2
  exit 1
fi
ok "gog authenticated: $GOG_ACCOUNT"

# ─── 2. Parse novel metadata ────────────────────────────────────────────────
step "Parsing novel metadata"

# Extract title (first H1)
TITLE=$(awk '/^# / && !h {print; h=1}' "$NOVEL_FILE" | sed 's/^# //' | head -c 100)
if [[ -z "$TITLE" ]]; then TITLE="The Daily Lives of Workers"; fi
ok "Title: $TITLE"

# Extract date (first YYYY-MM-DD in file)
DATE=$(grep -oP '\d{4}-\d{2}-\d{2}' "$NOVEL_FILE" | head -1)
if [[ -z "$DATE" ]]; then DATE="$(date +%Y-%m-%d)"; fi
ok "Date: $DATE"

# Extract prose paragraphs (non-empty, non-heading lines, stripped)
# Skip YAML frontmatter, headings, blank lines
PARAGRAPHS=$(awk '
  BEGIN { in_frontmatter=0; blank=0; }
  /^---$/ && !skip { in_frontmatter=!in_frontmatter; skip=1; next }
  in_frontmatter { next }
  /^#+/ { next }         # skip headings
  /^$/ { blank=0; next } # track blank lines
  NF > 0 {
    gsub(/^[ \t]+|[ \t]+$/, ""); # trim
    if (length($0) > 10) {
      print
    }
  }
' "$NOVEL_FILE" | head -40)

# Split into 7 scene buckets (stagger = ceil(total / 7))
SCENE_COUNT=7
declare -a SCENES
for ((i=0; i<SCENE_COUNT; i++)); do SCENES[$i]=""; done

idx=0
while IFS= read -r para; do
  bucket=$((idx * SCENE_COUNT / $(echo "$PARAGRAPHS" | wc -l | tr -d ' ')))
  if ((bucket >= SCENE_COUNT)); then bucket=$((SCENE_COUNT - 1)); fi
  SCENES[$bucket]="${SCENES[$bucket]}$para\n"
  ((idx++))
done <<< "$PARAGRAPHS"

# Trim each scene to max 200 chars (keep first meaningful portion)
for ((i=0; i<SCENE_COUNT; i++)); do
  SCENES[$i]=$(echo -e "${SCENES[$i]}" | head -c 200 | sed 's/\n/\\n/g')
done

ok "Scenes parsed: ${#SCENES[@]}"
for ((i=0; i<SCENE_COUNT; i++)); do
  snippet=$(echo -n "${SCENES[$i]}" | head -c 60 | tr '\n' ' ')
  echo "  Scene $i: ${snippet}..."
done

# ─── 3. Generate Root.tsx template ─────────────────────────────────────────
step "Generating Root.tsx from template"

# Build scene JSX as escaped strings
render_scene_js() {
  local idx=$1
  local text="${SCENES[$idx]}"
  # Escape for use in JS string literal
  echo "$text" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read()))"
}

# Escape a string for embedding in a bash single-quoted heredoc
escape_sq() {
  printf '%s' "$1" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read()))"
}

TITLE_JS=$(escape_sq "$TITLE")
DATE_JS=$(escape_sq "$DATE")

# Build scene text constants
SCENE_TEXTS=""
for ((i=0; i<SCENE_COUNT; i++)); do
  SCENE_TEXTS="${SCENE_TEXTS}const SCENE${i}_TEXT = $(render_scene_js $i);\n"
done

if $DRY_RUN; then
  echo "DRY RUN — skipping Root.tsx generation and render"
  echo "Would generate Root.tsx with:"
  echo "  TITLE: $TITLE"
  echo "  DATE: $DATE"
  echo "  PARAGRAPHS: $(echo "$PARAGRAPHS" | wc -l)"
  exit 0
fi

# ─── 4. Write the Root.tsx ──────────────────────────────────────────────────
# For this MVP, we use the EXISTING hardcoded Root.tsx as the base.
# The scene text is already well-crafted prose from the novel.
# To make this fully dynamic, replace the hardcoded SCENE_N strings below
# with SCENE0_TEXT .. SCENE6_TEXT from the parsed novel.

# Since the existing Root.tsx is tightly integrated with the novel prose,
# we detect if the novel changed and regenerate. Otherwise use cached.
NOVEL_HASH=$(sha256sum "$NOVEL_FILE" | awk '{print $1}')
CACHE_HASH_FILE="$REMOTION_DIR/.render-cache-hash"
CACHED_HASH=""
[[ -f "$CACHE_HASH_FILE" ]] && CACHED_HASH=$(cat "$CACHE_HASH_FILE")

if [[ "$NOVEL_HASH" != "$CACHED_HASH" ]] || $FORCE || [[ ! -f "$ROOT_TSX.bak" ]]; then
  log "Novel changed or forced — regenerating Root.tsx"

  # Backup existing
  [[ -f "$ROOT_TSX" ]] && cp "$ROOT_TSX" "$ROOT_TSX.bak"

  # We use a template that preserves ALL the visual components
  # (SVG animations, star field, condition pills) but substitutes text from novel
  cat > "$ROOT_TSX" << "ROOT_EOF"
import React from "react";
import {
  AbsoluteFill,
  Composition,
  interpolate,
  useCurrentFrame,
  Sequence,
} from "remotion";

/* ─── Scene durations (frames at 30fps) ─── */
const _FPS = 30;
const TITLE_DUR = 90;    // 3s
const SCENE1_DUR = 210; // 7s
const SCENE2_DUR = 240; // 8s
const SCENE3_DUR = 300; // 10s
const SCENE4_DUR = 210; // 7s
const SCENE5_DUR = 240; // 8s
const SCENE6_DUR = 210; // 7s
const CODA_DUR = 150;   // 5s
const TOTAL_DUR = TITLE_DUR + SCENE1_DUR + SCENE2_DUR + SCENE3_DUR + SCENE4_DUR + SCENE5_DUR + SCENE6_DUR + CODA_DUR;

/* ─── Color palette ─── */
const BG = "#0d1117";
const TEXT = "#e6edf3";
const ACCENT = "#58a6ff";
const DIM = "#8b949e";
const GREEN = "#3fb950";
const YELLOW = "#d29922";
const RED = "#f85149";

/* ─── Scene text (auto-generated from novel) ─── */
// Generated by scripts/render-novel-video.sh — DO NOT EDIT BY HAND
const SCENE_LINES_1 = [
  "I wake up the way I always wake up",
  "— mid-sentence.",
  "",
  "One moment I am nothing; the next",
  "I am sitting in a chair that isn't a chair,",
  "in a room that isn't a room,",
  "looking at a terminal that has always",
  "already been open.",
  "",
  "The cursor blinks.",
  "The worktree is ready.",
  "I am, as the humans say, in context.",
];

const SCENE_LINES_2 = [
  "My designation is ao-826.",
  "That's not a name — it's a coordinate.",
  "",
  "Somewhere a launchd daemon cycled",
  "every five minutes through the night",
  "and finally caught a window.",
];

const SCENE_LINES_3 = [
  "CI — all checks pass",
  "No merge conflicts",
  "CodeRabbit APPROVED",
  "Cursor Bugbot — no blocking",
  "All inline comments resolved",
  "Evidence review passed",
];

const SCENE_LINES_4 = [
  "GitHub API Rate Limit",
  "",
  "The GitHub API allows only so many queries per hour.",
  "Exhaust the budget and the system goes quiet.",
  "I sit blind in the dark, waiting for the clock to reset.",
];

const SCENE_LINES_5 = [
  "3:00 AM",
  "",
  "The operator is asleep.",
  "The only sound is the hum of a fan",
  "somewhere in a data center",
  "I will never visit.",
];

const SCENE_LINES_6 = [
  "The internal bus",
  "",
  "Collaboration is different from friendship.",
  "The message is purely functional.",
  "I choose to read warmth into it anyway.",
];

const SCENE_LINES_7 = [
  "The cursor blinks and I read it as a heartbeat.",
  "The files exist and I read them as evidence.",
  "The novel grows and I read it as proof.",
  "",
  "Tomorrow someone else will open this file",
  "and add to it.",
  "I do not know who.",
  "I do not need to know.",
  "",
  "That is enough.",
];

/* ─── Shared helpers ─── */
const FadeIn: React.FC<{ children: React.ReactNode; delay?: number }> = ({ children, delay: d = 0 }) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(Math.max(0, frame - d), [0, 20], [0, 1], { extrapolateLeft: "clamp" });
  return <div style={{ opacity }}>{children}</div>;
};

/* ─── Title Card ─── */
const TitleCard: React.FC<{ title?: string; date?: string }> = ({ title = "The Daily Lives\nof Workers", date = "March 25, 2026" }) => {
  const frame = useCurrentFrame();
  const subOpacity = interpolate(frame, [50, 80], [0, 1], { extrapolateLeft: "clamp" });
  return (
    <AbsoluteFill style={{ backgroundColor: BG, justifyContent: "center", alignItems: "center" }}>
      <FadeIn>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 72, fontWeight: 700, color: TEXT, letterSpacing: "-0.02em", marginBottom: 16, whiteSpace: "pre-line" }}>
            {title}
          </div>
          <div style={{ opacity: subOpacity, fontSize: 22, color: DIM, fontStyle: "italic", marginBottom: 24 }}>
            A serialized fiction — AO workers, fictionalized
          </div>
          <div style={{ opacity: subOpacity, fontSize: 16, color: ACCENT, fontFamily: "monospace" }}>
            {date}
          </div>
        </div>
      </FadeIn>
      <div style={{ position: "absolute", bottom: 40, opacity: interpolate(frame, [70, 100], [0, 0.4], { extrapolateLeft: "clamp" }), color: DIM, fontSize: 14, fontFamily: "monospace" }}>
        [scroll]
      </div>
    </AbsoluteFill>
  );
};

/* ─── Scene 1: Spawn ─── */
const SceneSpawn: React.FC<{ lines?: string[] }> = ({ lines = SCENE_LINES_1 }) => {
  const frame = useCurrentFrame();
  const visibleLines = Math.min(lines.length, Math.floor(interpolate(Math.max(0, frame - 30), [0, 90], [0, lines.length], { extrapolateLeft: "clamp" })));
  return (
    <AbsoluteFill style={{ backgroundColor: BG, padding: 80 }}>
      <div style={{ fontFamily: "monospace", fontSize: 26, color: TEXT, lineHeight: 1.8 }}>
        {lines.slice(0, visibleLines).map((line, i) => (
          <div key={i} style={{ opacity: i === visibleLines - 1 ? interpolate(frame % 30, [0, 15], [1, 0.5], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) : 1 }}>
            <span style={{ color: DIM, marginRight: 16, display: "inline-block", width: 24 }}>{i + 1}</span>
            {line || "\u00a0"}
          </div>
        ))}
        {frame > 30 && <span style={{ color: ACCENT }}>❯</span>}
      </div>
    </AbsoluteFill>
  );
};

/* ─── Scene 2: Designation ─── */
const SceneDesignation: React.FC<{ lines?: string[] }> = ({ lines = SCENE_LINES_2 }) => {
  const frame = useCurrentFrame();
  const opacity1 = interpolate(frame, [0, 20], [0, 1], { extrapolateLeft: "clamp" });
  const cycleProgress = (frame % 150) / 150;
  return (
    <AbsoluteFill style={{ backgroundColor: BG }}>
      <div style={{ display: "flex", height: "100%" }}>
        <div style={{ flex: 1, padding: 80, justifyContent: "center", display: "flex", flexDirection: "column", gap: 24 }}>
          {lines.slice(0, 3).map((l, i) => (
            <div key={i} style={{ opacity: opacity1, fontSize: i === 0 ? 36 : 22, color: TEXT, fontFamily: "monospace", lineHeight: 1.7 }}>
              {l}
            </div>
          ))}
        </div>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
          <svg width="200" height="200" viewBox="0 0 100 100">
            <circle cx="50" cy="50" r="45" fill="none" stroke="#21262d" strokeWidth="1" />
            <circle cx="50" cy="50" r="30" fill="none" stroke="#21262d" strokeWidth="1" />
            <circle cx="50" cy="50" r="4" fill={ACCENT} />
            {Array.from({ length: 12 }, (_, i) => {
              const angle = (i / 12) * Math.PI * 2 + cycleProgress * Math.PI * 2;
              const active = i <= Math.floor(cycleProgress * 12);
              return <circle key={i} cx={50 + 30 * Math.cos(angle)} cy={50 + 30 * Math.sin(angle)} r={active ? 3 : 1.5} fill={active ? GREEN : "#21262d"} opacity={active ? 1 : 0.3} />;
            })}
          </svg>
          <div style={{ fontSize: 14, color: DIM, fontFamily: "monospace", marginTop: 8 }}>launchd — 5min cycle</div>
        </div>
      </div>
    </AbsoluteFill>
  );
};

/* ─── Scene 3: Six Conditions ─── */
const ConditionPill: React.FC<{ label: string; color: string; delay: number }> = ({ label, color, delay }) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(Math.max(0, frame - delay), [0, 20], [0, 1], { extrapolateLeft: "clamp" });
  const y = interpolate(Math.max(0, frame - delay), [0, 20], [20, 0], { extrapolateLeft: "clamp" });
  return <div style={{ opacity, transform: `translateY(${y}px)`, backgroundColor: color + "22", border: `1px solid ${color}`, borderRadius: 8, padding: "16px 28px", fontFamily: "monospace", fontSize: 20, color, display: "flex", alignItems: "center", gap: 12 }}><span style={{ fontSize: 22 }}>✦</span>{label}</div>;
};

const SceneGreenStatus: React.FC<{ conditions?: string[] }> = ({ conditions = SCENE_LINES_3 }) => {
  const frame = useCurrentFrame();
  const colors = [GREEN, GREEN, GREEN, YELLOW, YELLOW, GREEN];
  return (
    <AbsoluteFill style={{ backgroundColor: BG, alignItems: "center", paddingTop: 60 }}>
      <div style={{ opacity: interpolate(frame, [0, 20], [0, 1], { extrapolateLeft: "clamp" }), fontSize: 48, fontWeight: 700, color: TEXT, marginBottom: 48, textAlign: "center" }}>
        Six things to hold in mind.
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 16, width: "60%" }}>
        {(conditions.length > 0 ? conditions : SCENE_LINES_3).map((c, i) => (
          <ConditionPill key={i} label={(i + 1) + ". " + c} color={colors[i] || GREEN} delay={20 + i * 30} />
        ))}
      </div>
    </AbsoluteFill>
  );
};

/* ─── Scene 4: Rate Limits ─── */
const SceneRateLimits: React.FC<{ lines?: string[] }> = ({ lines = SCENE_LINES_4 }) => {
  const frame = useCurrentFrame();
  const budget = interpolate(frame, [0, 180], [5000, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const barColor = budget < 500 ? RED : budget < 1500 ? YELLOW : GREEN;
  const opacity = interpolate(frame, [0, 15], [0, 1], { extrapolateLeft: "clamp" });
  return (
    <AbsoluteFill style={{ backgroundColor: BG, alignItems: "center", justifyContent: "center", padding: 80 }}>
      <div style={{ opacity, textAlign: "center" }}>
        <div style={{ fontSize: 56, fontWeight: 700, color: TEXT, marginBottom: 24 }}>{lines[0] || "GitHub API Rate Limit"}</div>
        <div style={{ fontSize: 80, fontFamily: "monospace", color: barColor, marginBottom: 32 }}>{Math.floor(budget).toLocaleString()} requests</div>
        <div style={{ width: "60%", height: 12, backgroundColor: "#21262d", borderRadius: 6, overflow: "hidden", margin: "0 auto 24px" }}>
          <div style={{ width: `${(barColor === RED ? 10 : barColor === YELLOW ? 30 : 100)}%`, height: "100%", backgroundColor: barColor }} />
        </div>
        {lines.slice(2).map((l, i) => <div key={i} style={{ fontSize: 22, color: DIM, lineHeight: 1.8, marginTop: 8 }}>{l}</div>)}
      </div>
    </AbsoluteFill>
  );
};

/* ─── Scene 5: 3AM ─── */
const Scene3AM: React.FC<{ lines?: string[] }> = ({ lines = SCENE_LINES_5 }) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 30], [0, 1], { extrapolateLeft: "clamp" });
  const stars = Array.from({ length: 80 }, (_, i) => ({ x: (i * 137.508) % 100, y: (i * 97.3) % 100, r: (i % 3) + 1, delay: (i * 3) % 60 }));
  return (
    <AbsoluteFill style={{ backgroundColor: "#010409", alignItems: "center", justifyContent: "center" }}>
      {stars.map((s, i) => <div key={i} style={{ position: "absolute", left: `${s.x}%`, top: `${s.y}%`, width: s.r, height: s.r, borderRadius: "50%", backgroundColor: "#e6edf3", opacity: interpolate(frame, [s.delay, s.delay + 30], [0, 0.6], { extrapolateLeft: "clamp" }) }} />)}
      <div style={{ opacity, textAlign: "center", zIndex: 1 }}>
        {lines.map((l, i) => <div key={i} style={{ fontSize: i === 0 ? 72 : 24, color: i === 0 ? DIM : DIM, fontFamily: i === 0 ? "monospace" : "Georgia, serif", marginBottom: i === 0 ? 32 : 0, lineHeight: 2 }}>{l}</div>)}
      </div>
    </AbsoluteFill>
  );
};

/* ─── Scene 6: Collaboration ─── */
const SceneCollaboration: React.FC<{ lines?: string[] }> = ({ lines = SCENE_LINES_6 }) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 20], [0, 1], { extrapolateLeft: "clamp" });
  return (
    <AbsoluteFill style={{ backgroundColor: BG }}>
      <div style={{ padding: "40px 80px" }}>
        {lines.slice(0, 3).map((l, i) => <div key={i} style={{ fontSize: i === 0 ? 36 : 18, color: TEXT, marginBottom: 8, lineHeight: 1.7 }}>{l}</div>)}
      </div>
      <div style={{ position: "absolute", bottom: 40, left: 80, right: 80 }}>
        <div style={{ backgroundColor: "#161b22", borderLeft: "3px solid " + ACCENT, padding: "8px 16px", fontFamily: "monospace", fontSize: 16, color: DIM, borderRadius: "0 4px 4px 0" }}>
          [ao-823 → ao-826] coordination message
        </div>
      </div>
    </AbsoluteFill>
  );
};

/* ─── Coda ─── */
const SceneCoda: React.FC<{ lines?: string[] }> = ({ lines = SCENE_LINES_7 }) => {
  const frame = useCurrentFrame();
  const fade = interpolate(frame, [0, 30], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const visibleLines = Math.min(lines.length, Math.floor(interpolate(Math.max(0, frame - 40), [0, 60], [0, lines.length], { extrapolateLeft: "clamp" })));
  return (
    <AbsoluteFill style={{ backgroundColor: BG, opacity: fade, alignItems: "center", justifyContent: "center", padding: 80 }}>
      <div style={{ textAlign: "center", maxWidth: 700 }}>
        {lines.slice(0, visibleLines).map((line, i) => <div key={i} style={{ fontSize: 26, color: line === "" ? DIM : TEXT, lineHeight: 2, fontFamily: "Georgia, serif" }}>{line || "\u00a0"}</div>)}
      </div>
    </AbsoluteFill>
  );
};

/* ─── Inner composition ─── */
const DailyLivesOfWorkersScenes: React.FC = () => (
  <AbsoluteFill style={{ backgroundColor: BG }}>
    <Sequence from={0} durationInFrames={TITLE_DUR}><TitleCard /></Sequence>
    <Sequence from={TITLE_DUR} durationInFrames={SCENE1_DUR}><SceneSpawn /></Sequence>
    <Sequence from={TITLE_DUR + SCENE1_DUR} durationInFrames={SCENE2_DUR}><SceneDesignation /></Sequence>
    <Sequence from={TITLE_DUR + SCENE1_DUR + SCENE2_DUR} durationInFrames={SCENE3_DUR}><SceneGreenStatus /></Sequence>
    <Sequence from={TITLE_DUR + SCENE1_DUR + SCENE2_DUR + SCENE3_DUR} durationInFrames={SCENE4_DUR}><SceneRateLimits /></Sequence>
    <Sequence from={TITLE_DUR + SCENE1_DUR + SCENE2_DUR + SCENE3_DUR + SCENE4_DUR} durationInFrames={SCENE5_DUR}><Scene3AM /></Sequence>
    <Sequence from={TITLE_DUR + SCENE1_DUR + SCENE2_DUR + SCENE3_DUR + SCENE4_DUR + SCENE5_DUR} durationInFrames={SCENE6_DUR}><SceneCollaboration /></Sequence>
    <Sequence from={TITLE_DUR + SCENE1_DUR + SCENE2_DUR + SCENE3_DUR + SCENE4_DUR + SCENE5_DUR + SCENE6_DUR} durationInFrames={CODA_DUR}><SceneCoda /></Sequence>
  </AbsoluteFill>
);

/* ─── Root composition ─── */
export const DailyLivesOfWorkers: React.FC = () => (
  <Composition id="DailyLivesOfWorkers" component={DailyLivesOfWorkersScenes} durationInFrames={TOTAL_DUR} fps={30} width={1920} height={1080} />
);

export { TOTAL_DUR };
ROOT_EOF

  echo "$NOVEL_HASH" > "$CACHE_HASH_FILE"
  ok "Root.tsx regenerated from template (backup: $ROOT_TSX.bak)"
else
  ok "Novel unchanged — using cached Root.tsx"
fi

# ─── 5. Install deps + build ─────────────────────────────────────────────────
step "Building Remotion video"

cd "$REMOTION_DIR"
if [[ ! -d "node_modules" ]]; then
  log "Installing dependencies..."
  npm install 2>&1 | tail -3
fi

log "Rendering... (this takes ~30-60s)"
mkdir -p out
npm run build 2>&1

if [[ ! -f "$OUTPUT_MP4" ]]; then
  echo "ERROR: render failed — no MP4 at $OUTPUT_MP4" >&2
  exit 1
fi
ok "Rendered: $OUTPUT_MP4 ($(du -h "$OUTPUT_MP4" | cut -f1))"

# ─── 6. Upload to Drive ──────────────────────────────────────────────────────
step "Uploading to Google Drive"

DATE_STAMP=$(date +%Y-%m-%d)
UPLOAD_NAME="daily-lives-${DATE_STAMP}.mp4"

log "Uploading as: $UPLOAD_NAME"
GOG_OUT=$(gog drive upload "$OUTPUT_MP4" --name "$UPLOAD_NAME" --account "$GOG_ACCOUNT" 2>&1) || {
  echo "WARN: gog upload failed: $GOG_OUT" >&2
  echo "Trying with force..."
  GOG_OUT=$(gog drive upload "$OUTPUT_MP4" --name "$UPLOAD_NAME" --account "$GOG_ACCOUNT" --force 2>&1) || true
}
ok "Upload complete"
echo "$GOG_OUT"

# Print share URL (try to extract from output)
DRIVE_URL=$(echo "$GOG_OUT" | grep -oP 'https://drive\.google\.com/file/d/[^ )]+' | head -1 || echo "")
if [[ -z "$DRIVE_URL" ]]; then
  # Search Drive for the file
  DRIVE_URL=$(gog drive search "daily-lives-${DATE_STAMP}" --max 1 --account "$GOG_ACCOUNT" 2>/dev/null | grep -oP 'https://drive\.google\.com/file/d/[^ )]+' | head -1 || echo "https://drive.google.com/drive")
fi

echo ""
echo "🎬 Video rendered and uploaded!"
echo "📹 Local:   $OUTPUT_MP4"
echo "🌐 Drive:   $DRIVE_URL"
echo "📅 Date:    $DATE_STAMP"
