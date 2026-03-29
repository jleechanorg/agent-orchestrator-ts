import React from "react";
import { interpolate, useCurrentFrame } from "remotion";

/* ─── Color palette ─── */
const ACCENT = "#58a6ff";
const GREEN = "#3fb950";
const YELLOW = "#d29922";
const DIM = "#8b949e";

/* ─── Shared spring-like bounce ─── */
const bounce = (frame: number, period = 30, amp = 4) =>
  Math.abs(Math.sin((frame / period) * Math.PI * 2)) * amp;

/* ─── Walking Robot (bounces up/down, arms/legs animate) ─── */
export const WalkingRobot: React.FC<{
  x?: number;
  y?: number;
  flipX?: boolean;
  speed?: number;
  colorIdx?: number;
}> = ({ x = 50, y = 70, flipX = false, speed = 1, colorIdx = 0 }) => {
  const frame = useCurrentFrame();
  const headColors = [ACCENT, GREEN, YELLOW, "#f778ba"];
  const bodyColors = ["#1f6feb", "#238636", "#9e6a03", "#ae3c72"];
  const hc = headColors[colorIdx % headColors.length];
  const bc = bodyColors[colorIdx % bodyColors.length];

  const bounceY = bounce(frame * speed, 20, 4);
  const legPhase = (frame * speed * 3) % (Math.PI * 2);

  return (
    <div
      style={{
        position: "absolute",
        left: `${x}%`,
        top: `${y}%`,
        transform: `translate(-50%, -50%) translateY(${-bounceY}px)${flipX ? " scaleX(-1)" : ""}`,
      }}
    >
      <svg width="60" height="80" viewBox="0 0 80 100">
        {/* Antenna */}
        <line x1="40" y1="10" x2="40" y2="0" stroke={hc} strokeWidth="3" strokeLinecap="round" />
        <circle cx="40" cy="0" r="4" fill={hc} opacity={0.8} />

        {/* Head */}
        <rect x="15" y="10" width="50" height="38" rx="10" fill={hc} />
        {/* Eyes - blinking */}
        <circle cx="30" cy="26" r="7" fill="#0d1117" />
        <circle cx="50" cy="26" r="7" fill="#0d1117" />
        {Math.floor(frame / 45) % 5 !== 0 && (
          <>
            <circle cx="32" cy="24" r="3" fill="#e6edf3" />
            <circle cx="52" cy="24" r="3" fill="#e6edf3" />
          </>
        )}
        {/* Smile */}
        <path d="M 28 36 Q 40 44 52 36" stroke="#0d1117" strokeWidth="2.5" fill="none" strokeLinecap="round" />

        {/* Body */}
        <rect x="10" y="50" width="60" height="36" rx="8" fill={bc} />
        {/* Chest screen */}
        <rect x="20" y="55" width="40" height="18" rx="4" fill="#0d1117" />
        {/* Legs - walking animation */}
        <rect
          x="18"
          y="86"
          width="14"
          height="14"
          rx="5"
          fill={hc}
          transform={`rotate(${Math.sin(legPhase) * 15}, 25, 93)`}
        />
        <rect
          x="48"
          y="86"
          width="14"
          height="14"
          rx="5"
          fill={hc}
          transform={`rotate(${-Math.sin(legPhase) * 15}, 55, 93)`}
        />
        {/* Arms - swinging */}
        <rect
          x="0"
          y="52"
          width="10"
          height="24"
          rx="5"
          fill={hc}
          transform={`rotate(${-Math.sin(legPhase) * 12}, 5, 64)`}
        />
        <rect
          x="70"
          y="52"
          width="10"
          height="24"
          rx="5"
          fill={hc}
          transform={`rotate(${Math.sin(legPhase) * 12}, 75, 64)`}
        />
      </svg>
    </div>
  );
};

/* ─── Typing Robot (sits at terminal, arms move) ─── */
export const TypingRobot: React.FC<{ x?: number; y?: number; colorIdx?: number }> = ({
  x = 30,
  y = 65,
  colorIdx = 0,
}) => {
  const frame = useCurrentFrame();
  const headColors = [ACCENT, GREEN, YELLOW, "#f778ba"];
  const bodyColors = ["#1f6feb", "#238636", "#9e6a03", "#ae3c72"];
  const hc = headColors[colorIdx % headColors.length];
  const bc = bodyColors[colorIdx % bodyColors.length];

  return (
    <div style={{ position: "absolute", left: `${x}%`, top: `${y}%`, transform: "translate(-50%, -50%)" }}>
      <svg width="90" height="110" viewBox="0 0 90 110">
        {/* Desk */}
        <rect x="0" y="85" width="90" height="25" rx="4" fill={bc} />
        {/* Monitor */}
        <rect x="10" y="30" width="70" height="55" rx="6" fill="#161b22" stroke={hc} strokeWidth="2" />
        <rect x="15" y="35" width="60" height="42" rx="3" fill="#0d1117" />
        {/* Screen content */}
        <rect x="18" y="38" width="35" height="3" rx="1" fill={GREEN} opacity={0.8} />
        <rect x="18" y="44" width="50" height="3" rx="1" fill={DIM} opacity={0.6} />
        <rect x="18" y="50" width="28" height="3" rx="1" fill={DIM} opacity={0.6} />
        <rect x="18" y="56" width="40" height="3" rx="1" fill={ACCENT} opacity={0.8} />
        <rect x="18" y="62" width="20" height="3" rx="1" fill={YELLOW} opacity={0.7} />
        {/* Monitor stand */}
        <rect x="40" y="85" width="10" height="10" fill="#30363d" />

        {/* Robot head above monitor */}
        <rect x="20" y="5" width="50" height="28" rx="8" fill={hc} />
        {/* Eyes */}
        <circle cx="33" cy="16" r="5" fill="#0d1117" />
        <circle cx="57" cy="16" r="5" fill="#0d1117" />
        {Math.floor(frame / 45) % 5 !== 0 && (
          <>
            <circle cx="35" cy="14" r="2.5" fill="#e6edf3" />
            <circle cx="59" cy="14" r="2.5" fill="#e6edf3" />
          </>
        )}
        {/* Mouth - excited typing face */}
        <path d="M 33 24 Q 45 30 57 24" stroke="#0d1117" strokeWidth="2" fill="none" strokeLinecap="round" />

        {/* Robot arms typing */}
        {/* Left arm */}
        <rect x="5" y="55" width="15" height="8" rx="4" fill={hc}
          transform={`rotate(${Math.sin(frame * 0.4) * 8}, 12, 59)`} />
        {/* Right arm */}
        <rect x="70" y="55" width="15" height="8" rx="4" fill={hc}
          transform={`rotate(${-Math.sin(frame * 0.4) * 8}, 77, 59)`} />
      </svg>
    </div>
  );
};

/* ─── Flying Drone Robot ─── */
export const DroneRobot: React.FC<{ x?: number; y?: number; colorIdx?: number }> = ({
  x = 50,
  y = 30,
  colorIdx = 0,
}) => {
  const frame = useCurrentFrame();
  const colors = [ACCENT, GREEN, YELLOW];
  const c = colors[colorIdx % colors.length];

  const hoverY = Math.sin(frame * 0.08) * 8;
  const rotor1 = (frame * 15) % 360;
  const rotor2 = (-frame * 15) % 360;

  return (
    <div
      style={{
        position: "absolute",
        left: `${x}%`,
        top: `${y}%`,
        transform: `translate(-50%, -50%) translateY(${hoverY}px)`,
      }}
    >
      <svg width="100" height="60" viewBox="0 0 100 60">
        {/* Rotors */}
        <ellipse cx="20" cy="15" rx="18" ry="4" fill="none" stroke={DIM} strokeWidth="2"
          opacity={0.5} transform={`rotate(${rotor1}, 20, 15)`} />
        <ellipse cx="80" cy="15" rx="18" ry="4" fill="none" stroke={DIM} strokeWidth="2"
          opacity={0.5} transform={`rotate(${rotor2}, 80, 15)`} />
        {/* Body */}
        <rect x="30" y="20" width="40" height="28" rx="8" fill={c} />
        {/* Eyes */}
        <circle cx="42" cy="32" r="5" fill="#0d1117" />
        <circle cx="58" cy="32" r="5" fill="#0d1117" />
        <circle cx="44" cy="30" r="2" fill="#e6edf3" />
        <circle cx="60" cy="30" r="2" fill="#e6edf3" />
        {/* Smile */}
        <path d="M 42 40 Q 50 46 58 40" stroke="#0d1117" strokeWidth="2" fill="none" strokeLinecap="round" />
        {/* LED */}
        <circle cx="50" cy="22" r="4" fill={GREEN} opacity={0.9} />
        {/* Arms holding package */}
        <rect x="10" y="35" width="20" height="6" rx="3" fill={c} opacity={0.8} />
        <rect x="70" y="35" width="20" height="6" rx="3" fill={c} opacity={0.8} />
        <rect x="30" y="48" width="40" height="8" rx="3" fill={YELLOW} opacity={0.8} />
      </svg>
    </div>
  );
};

/* ─── Robot with Flag (celebration) ─── */
export const CelebratingRobot: React.FC<{ x?: number; y?: number; colorIdx?: number }> = ({
  x = 60,
  y = 65,
  colorIdx = 0,
}) => {
  const frame = useCurrentFrame();
  const headColors = [ACCENT, GREEN, YELLOW, "#f778ba"];
  const bodyColors2 = ["#1f6feb", "#238636", "#9e6a03", "#ae3c72"];
  const hc = headColors[colorIdx % headColors.length];
  const bc = bodyColors2[colorIdx % bodyColors2.length];

  const waveAngle = Math.sin(frame * 0.2) * 30;

  return (
    <div style={{ position: "absolute", left: `${x}%`, top: `${y}%`, transform: "translate(-50%, -50%)" }}>
      <svg width="80" height="100" viewBox="0 0 80 100">
        {/* Body */}
        <rect x="10" y="50" width="60" height="38" rx="8" fill={bc} />
        {/* Chest: green checkmark glow */}
        <rect x="20" y="56" width="40" height="20" rx="4" fill="#0d1117" />
        <text x="40" y="70" textAnchor="middle" fill={GREEN} fontSize="16">✓</text>
        {/* Legs */}
        <rect x="20" y="88" width="14" height="12" rx="5" fill={hc} />
        <rect x="46" y="88" width="14" height="12" rx="5" fill={hc} />
        {/* Left arm: waving */}
        <rect x="0" y="52" width="10" height="28" rx="5" fill={hc}
          transform={`rotate(${-waveAngle}, 5, 64)`} />
        {/* Right arm */}
        <rect x="70" y="52" width="10" height="28" rx="5" fill={hc} />
        {/* Flag pole */}
        <line x1="62" y1="20" x2="62" y2="52" stroke={hc} strokeWidth="2" />
        {/* Flag */}
        <path d="M 62 20 L 80 26 L 62 34 Z" fill={GREEN} />
        {/* Head */}
        <rect x="15" y="10" width="50" height="38" rx="10" fill={hc} />
        {/* Eyes - happy */}
        <circle cx="30" cy="26" r="7" fill="#0d1117" />
        <circle cx="50" cy="26" r="7" fill="#0d1117" />
        <circle cx="32" cy="24" r="3" fill="#e6edf3" />
        <circle cx="52" cy="24" r="3" fill="#e6edf3" />
        {/* Big smile */}
        <path d="M 26 34 Q 40 46 54 34" stroke="#0d1117" strokeWidth="2.5" fill="none" strokeLinecap="round" />
        {/* Antenna */}
        <line x1="40" y1="10" x2="40" y2="0" stroke={hc} strokeWidth="3" strokeLinecap="round" />
        <circle cx="40" cy="0" r="4" fill={GREEN} />
      </svg>
    </div>
  );
};

/* ─── Group of little robots marching ─── */
export const RobotMarch: React.FC<{ count?: number; y?: number }> = ({ count = 4, y = 80 }) => {
  const frame = useCurrentFrame();
  return (
    <div style={{ position: "absolute", left: 0, right: 0, bottom: `${100 - y}%`, height: 80 }}>
      {Array.from({ length: count }, (_, i) => {
        const dir = (i % 2 === 0) ? 1 : -1;
        const raw = i * 25 + frame * 0.3 * dir;
        const leftPct = (((raw % 120) + 120) % 120) - 10;
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: `${leftPct}%`,
              top: `${(i % 3) * 10}%`,
            }}
          >
            <WalkingRobot x={0} y={0} flipX={i % 2 === 0} speed={0.8 + i * 0.1} colorIdx={i} />
          </div>
        );
      })}
    </div>
  );
};

/* ─── Robot team working together (stacked, collaborative) ─── */
export const RobotTeam: React.FC<{ robotCount?: number }> = ({ robotCount = 3 }) => {
  const frame = useCurrentFrame();
  return (
    <div style={{ position: "absolute", inset: 0 }}>
      {Array.from({ length: robotCount }, (_, i) => {
        const xPos = 20 + i * 30;
        const yBase = 70;
        const bobble = Math.sin(frame * 0.1 + i * 1.2) * 3;
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: `${xPos}%`,
              top: `${yBase}%`,
              transform: `translate(-50%, -50%) translateY(${bobble}px)`,
            }}
          >
            <WalkingRobot x={0} y={0} colorIdx={i} speed={0.5 + i * 0.15} />
          </div>
        );
      })}
    </div>
  );
};

/* ─── Star field sparkles (little robot helpers) ─── */
export const SparkleRobot: React.FC<{ x: number; y: number; delay: number; colorIdx?: number }> = ({
  x,
  y,
  delay,
  colorIdx = 0,
}) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(Math.max(0, frame - delay), [0, 15, 40, 50], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const scale = interpolate(Math.max(0, frame - delay), [0, 10, 40, 50], [0.3, 1.2, 1, 0.3], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const c = [ACCENT, GREEN, YELLOW][colorIdx % 3];

  return (
    <div
      style={{
        position: "absolute",
        left: `${x}%`,
        top: `${y}%`,
        transform: `translate(-50%, -50%) scale(${scale})`,
        opacity,
      }}
    >
      <svg width="24" height="24" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="5" fill={c} />
        <line x1="12" y1="0" x2="12" y2="5" stroke={c} strokeWidth="2" strokeLinecap="round" />
        <line x1="12" y1="19" x2="12" y2="24" stroke={c} strokeWidth="2" strokeLinecap="round" />
        <line x1="0" y1="12" x2="5" y2="12" stroke={c} strokeWidth="2" strokeLinecap="round" />
        <line x1="19" y1="12" x2="24" y2="12" stroke={c} strokeWidth="2" strokeLinecap="round" />
        <circle cx="12" cy="12" r="3" fill="#e6edf3" />
      </svg>
    </div>
  );
};

/* ─── Loading / Processing Robot ─── */
export const LoadingRobot: React.FC<{ x?: number; y?: number; colorIdx?: number }> = ({
  x = 50,
  y = 50,
  colorIdx = 0,
}) => {
  const frame = useCurrentFrame();
  const headColors = [ACCENT, GREEN, YELLOW, "#f778ba"];
  const hc = headColors[colorIdx % headColors.length];
  const bodyColors2 = ["#1f6feb", "#238636", "#9e6a03", "#ae3c72"];
  const bc = bodyColors2[colorIdx % bodyColors2.length];

  const spinAngle = frame * 5;
  const eyeBlink = Math.floor(frame / 45) % 5 === 0;

  return (
    <div style={{ position: "absolute", left: `${x}%`, top: `${y}%`, transform: "translate(-50%, -50%)" }}>
      <svg width="80" height="100" viewBox="0 0 80 100">
        {/* Body */}
        <rect x="10" y="50" width="60" height="38" rx="8" fill={bc} />
        {/* Spinning gears — on top of body */}
        <circle cx="25" cy="65" r="10" fill="none" stroke={hc} strokeWidth="3" opacity={0.6}
          strokeDasharray="4 3"
          transform={`rotate(${spinAngle}, 25, 65)`} />
        <circle cx="55" cy="70" r="8" fill="none" stroke={hc} strokeWidth="2.5" opacity={0.6}
          strokeDasharray="3 3"
          transform={`rotate(${-spinAngle * 1.5}, 55, 70)`} />
        {/* Head */}
        <rect x="15" y="10" width="50" height="38" rx="10" fill={hc} />
        {/* Eyes */}
        <circle cx="30" cy="26" r="7" fill="#0d1117" />
        <circle cx="50" cy="26" r="7" fill="#0d1117" />
        {!eyeBlink && (
          <>
            <circle cx="32" cy="24" r="3" fill="#e6edf3" />
            <circle cx="52" cy="24" r="3" fill="#e6edf3" />
          </>
        )}
        {/* Focused mouth */}
        <line x1="32" y1="37" x2="48" y2="37" stroke="#0d1117" strokeWidth="2.5" strokeLinecap="round" />
        {/* Antenna */}
        <line x1="40" y1="10" x2="40" y2="0" stroke={hc} strokeWidth="3" strokeLinecap="round" />
        <circle cx="40" cy="0" r="4" fill={YELLOW} />
        {/* Legs */}
        <rect x="20" y="88" width="14" height="12" rx="5" fill={hc} />
        <rect x="46" y="88" width="14" height="12" rx="5" fill={hc} />
      </svg>
    </div>
  );
};
