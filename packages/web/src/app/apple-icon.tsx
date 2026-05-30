import { ImageResponse } from "next/og";
import { getProjectName } from "@/lib/project-name";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

/** Derive a consistent hue from a string (0-360). */
function stringToHue(s: string): number {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = s.charCodeAt(i) + ((hash << 5) - hash);
  }
  return ((hash % 360) + 360) % 360;
}

export default function AppleIcon() {
  const name = getProjectName();
  const initial = (name.charAt(0) || "A").toUpperCase();
  const hue = stringToHue(name);

  return new ImageResponse(
    (
      <div
        style={{
          width: "180px",
          height: "180px",
          borderRadius: "36px",
          background: `hsl(${hue}, 60%, 45%)`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "white",
          fontSize: "110px",
          fontWeight: 700,
          fontFamily: "sans-serif",
        }}
      >
        {initial}
      </div>
    ),
    { ...size },
  );
}
