import React, { useEffect, useState } from "react";
import {
  AbsoluteFill,
  Sequence,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
  spring,
} from "remotion";
import { ChapterData, DEFAULT_CHAPTER } from "./ChapterData";

// ─── Shared background (same aesthetic as TheAwakening) ───────────────────────

const Background: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <AbsoluteFill
    style={{
      background: "#0a0a0a",
      fontFamily: "'IM Fell English', Georgia, serif",
    }}
  >
    <div
      style={{
        position: "absolute",
        inset: 0,
        background:
          "radial-gradient(ellipse at 50% 50%, transparent 40%, rgba(0,0,0,0.7) 100%)",
        pointerEvents: "none",
      }}
    />
    {children}
  </AbsoluteFill>
);

// ─── Typewriter effect ────────────────────────────────────────────────────────

const TypewriterText: React.FC<{ text: string; startFrame: number; delay?: number }> = ({
  text,
  startFrame,
  delay = 0,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const visibleChars = interpolate(
    Math.max(0, frame - startFrame - delay),
    [0, text.length * 1.8],
    [0, text.length],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  return (
    <span style={{ color: "#e8dcc8" }}>
      {text.slice(0, Math.floor(visibleChars))}
      {frame < startFrame + delay + text.length * 1.8 && (
        <span style={{ opacity: 0.8, color: "#f0e8d0" }}>|</span>
      )}
    </span>
  );
};

// ─── Fade in ─────────────────────────────────────────────────────────────────

const FadeIn: React.FC<{ children: React.ReactNode; startFrame: number; duration?: number }> = ({
  children,
  startFrame,
  duration = 30,
}) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(Math.max(0, frame - startFrame), [0, duration], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return <div style={{ opacity, position: "absolute", inset: 0 }}>{children}</div>;
};

// ─── Word-by-word reveal (for short excerpts) ────────────────────────────────

const WordReveal: React.FC<{ words: string[]; startFrame: number; fps: number }> = ({
  words,
  startFrame,
  fps,
}) => {
  const frame = useCurrentFrame();
  const [shownWords, setShownWords] = useState(0);

  useEffect(() => {
    const elapsed = Math.max(0, frame - startFrame);
    const newCount = Math.floor((elapsed * fps) / 1200); // ~20 words per second
    setShownWords(Math.min(newCount, words.length));
  }, [frame, startFrame, fps, words.length]);

  return (
    <div
      style={{
        fontSize: "2.4rem",
        lineHeight: 1.7,
        textAlign: "center",
        color: "#e8dcc8",
        padding: "0 10%",
        fontStyle: "italic",
        fontFamily: "'IM Fell English', Georgia, serif",
      }}
    >
      {words.slice(0, shownWords).join(" ")}
      {shownWords < words.length && (
        <span style={{ opacity: 0.7, color: "#f0e8d0" }}>|</span>
      )}
    </div>
  );
};

// ─── Chapter title card ─────────────────────────────────────────────────────

const ChapterTitleCard: React.FC<{ title: string; subtitle?: string }> = ({
  title,
  subtitle,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const scale = spring({ frame, fps, from: 0.5, to: 1, config: { damping: 12 } });
  const opacity = interpolate(frame, [0, 20], [0, 1], { extrapolateLeft: "clamp" });

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        opacity,
        transform: `scale(${scale})`,
      }}
    >
      <div
        style={{
          borderLeft: "2px solid rgba(212,175,120,0.6)",
          paddingLeft: "1.5rem",
        }}
      >
        <div
          style={{
            fontSize: "3.5rem",
            fontWeight: 700,
            color: "#d4af78",
            fontFamily: "'Cinzel', Georgia, serif",
            letterSpacing: "0.05em",
            textTransform: "uppercase",
            marginBottom: "1rem",
            textShadow: "0 0 40px rgba(212,175,120,0.3)",
          }}
        >
          {title}
        </div>
        {subtitle && (
          <div
            style={{
              fontSize: "1.4rem",
              color: "rgba(232,220,200,0.7)",
              fontStyle: "italic",
              fontFamily: "'IM Fell English', Georgia, serif",
            }}
          >
            {subtitle}
          </div>
        )}
      </div>
    </div>
  );
};

// ─── Closing card ────────────────────────────────────────────────────────────

const ClosingCard: React.FC<{ chapter: string }> = ({ chapter }) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 20], [0, 1], { extrapolateLeft: "clamp" });
  const fadeOut = interpolate(frame, [25, 40], [1, 0], { extrapolateRight: "clamp" });

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        opacity: Math.min(opacity, fadeOut),
      }}
    >
      <div
        style={{
          fontSize: "1.2rem",
          color: "rgba(212,175,120,0.5)",
          fontFamily: "'Cinzel', Georgia, serif",
          letterSpacing: "0.3em",
          textTransform: "uppercase",
          marginBottom: "2rem",
        }}
      >
        To Be Continued
      </div>
      <div
        style={{
          fontSize: "1rem",
          color: "rgba(232,220,200,0.3)",
          fontStyle: "italic",
          fontFamily: "'IM Fell English', Georgia, serif",
        }}
      >
        {chapter} — The Daily Lives of Workers
      </div>
      <div
        style={{
          marginTop: "3rem",
          fontSize: "0.9rem",
          color: "rgba(212,175,120,0.25)",
          fontFamily: "'Cinzel', Georgia, serif",
          letterSpacing: "0.15em",
        }}
      >
        agentorchestrator.ai
      </div>
    </div>
  );
};

// ─── Main DailyChapter composition ───────────────────────────────────────────

export const DailyChapter: React.FC<{ chapter?: ChapterData }> = ({ chapter }) => {
  const data = chapter ?? DEFAULT_CHAPTER;
  const { fps } = useVideoConfig();

  // Parse excerpt into words for reveal
  const excerptWords = data.excerpt.replace(/\n/g, ' ').split(/\s+/).filter(Boolean);
  // Take first 80 words for the reveal (keeps it punchy for Shorts)
  const shortExcerpt = excerptWords.slice(0, 80);

  // Total duration: title + excerpt + closing
  const TITLE_DURATION = 90;   // frames (~1.5s)
  const EXCERPT_START = 90;
  const EXCERPT_DURATION = shortExcerpt.length * (fps * 60 / 1200); // ~20 wpm
  const CLOSING_START = EXCERPT_START + EXCERPT_DURATION + 30;
  const TOTAL_FRAMES = CLOSING_START + 50;

  return (
    <AbsoluteFill
      style={{
        background: "#0a0a0a",
        fontFamily: "'IM Fell English', Georgia, serif",
        overflow: "hidden",
      }}
    >
      {/* Ambient gradient */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(ellipse at 50% 50%, rgba(30,20,10,0.3) 0%, rgba(0,0,0,0.95) 100%)",
          pointerEvents: "none",
        }}
      />

      {/* Grain overlay */}
      <svg
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0.04, pointerEvents: "none" }}
      >
        <filter id="grain">
          <feTurbulence type="fractalNoise" baseFrequency="0.65" numOctaves="3" stitchTiles="stitch" />
          <feColorMatrix type="saturate" values="0" />
        </filter>
        <rect width="100%" height="100%" filter="url(#grain)" />
      </svg>

      {/* Google Fonts */}
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Cinzel:wght@400;700&family=IM+Fell+English:ital@0;1&display=swap');
      `}</style>

      {/* Chapter title */}
      <Sequence from={0} durationInFrames={TITLE_DURATION}>
        <ChapterTitleCard title={data.heading} subtitle="The Daily Lives of Workers" />
      </Sequence>

      {/* Excerpt reveal */}
      <Sequence from={EXCERPT_START}>
        <FadeIn startFrame={0} duration={20}>
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "0 8%",
            }}
          >
            <WordReveal words={shortExcerpt} startFrame={0} fps={fps} />
          </div>
        </FadeIn>
      </Sequence>

      {/* Closing card */}
      <Sequence from={CLOSING_START}>
        <ClosingCard chapter={data.heading} />
      </Sequence>
    </AbsoluteFill>
  );
};

export default DailyChapter;
