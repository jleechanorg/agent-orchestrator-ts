import React from "react";
import { Composition } from "remotion";
import { TheAwakening } from "./TheAwakening";
import { TOTAL_FRAMES } from "./scenes";
import { ThePantheon } from "./ThePantheon";
import { PANTHEON_TOTAL_FRAMES } from "./pantheon-data";
import { DailyChapter } from "./DailyChapter";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="TheAwakening"
        component={TheAwakening}
        durationInFrames={TOTAL_FRAMES}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="ThePantheon"
        component={ThePantheon}
        durationInFrames={PANTHEON_TOTAL_FRAMES}
        fps={30}
        width={1920}
        height={1080}
      />
      <Composition
        id="DailyChapter"
        component={DailyChapter}
        durationInFrames={300}  // 10s at 30fps
        fps={30}
        width={1080}
        height={1920}  // 9:16 portrait for Shorts/TikTok
      />
    </>
  );
};
