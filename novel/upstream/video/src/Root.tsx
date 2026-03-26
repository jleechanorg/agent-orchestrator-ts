import React from "react";
import { Composition, type CalculateMetadataFunction } from "remotion";
import { TheAwakening } from "./TheAwakening";
import { TOTAL_FRAMES } from "./scenes";
import { ThePantheon } from "./ThePantheon";
import { PANTHEON_TOTAL_FRAMES } from "./pantheon-data";
import { DailyChapter, DEFAULT_CHAPTER } from "./DailyChapter";
import type { ChapterData } from "./ChapterData";

const calculateDailyChapterDuration: CalculateMetadataFunction<{ chapter?: ChapterData }> = ({
  props,
}) => {
  const chapter = props.chapter ?? DEFAULT_CHAPTER;
  const words = chapter.excerpt
    .replace(/\n/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 80);
  const excerptDuration = Math.ceil(words.length * (30 * 60) / 1200);
  const totalFrames = 90 + excerptDuration + 30 + 50;
  return { durationInFrames: totalFrames };
};

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
        fps={30}
        width={1080}
        height={1920}
        calculateMetadata={calculateDailyChapterDuration}
      />
    </>
  );
};
