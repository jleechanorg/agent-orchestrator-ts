/**
 * DailyChapter timing calculation tests.
 *
 * These verify the frame/timing logic used by the DailyChapter composition.
 * They test the pure calculation functions without requiring full Remotion rendering.
 */

import { describe, it, expect } from "vitest";

// Extracted timing logic from DailyChapter.tsx for testability
const TITLE_DURATION = 90; // frames (~1.5s at 30fps)
const EXCERPT_START = TITLE_DURATION;
const WORDS_PER_MINUTE = 20; // ~20 wpm (words per minute at 30fps)

function computeExcerptDuration(shortExcerptLength: number, fps: number): number {
  // 20 wpm = 1 word per 3 seconds. At fps frames/second, each word spans 3*fps frames.
  return Math.ceil(shortExcerptLength * 3 * fps);
}

function computeClosingStart(excerptDuration: number): number {
  return EXCERPT_START + excerptDuration + 30;
}

function computeTotalFrames(closingStart: number): number {
  return closingStart + 50;
}

function parseExcerptWords(excerpt: string): string[] {
  return excerpt
    .replace(/\n/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 80);
}

describe("DailyChapter timing calculations", () => {
  describe("computeExcerptDuration", () => {
    it("computes 7200 frames for 80 words at 30fps (~20wpm)", () => {
      // 20 wpm = 1 word per 3 seconds. At 30fps: 80 words × 3 s/word × 30 fps = 7200 frames
      expect(computeExcerptDuration(80, 30)).toBe(7200);
    });

    it("computes 2700 frames for 30 words at 30fps", () => {
      expect(computeExcerptDuration(30, 30)).toBe(2700);
    });

    it("returns 0 for 0 words", () => {
      expect(computeExcerptDuration(0, 30)).toBe(0);
    });

    it("scales linearly with word count", () => {
      const d40 = computeExcerptDuration(40, 30);
      const d80 = computeExcerptDuration(80, 30);
      expect(d80).toBeCloseTo(d40 * 2, 0);
    });
  });

  describe("CLOSING_START calculation", () => {
    it("closes 30 frames after excerpt ends", () => {
      const excerptDuration = computeExcerptDuration(80, 30);
      const closingStart = computeClosingStart(excerptDuration);
      expect(closingStart).toBe(EXCERPT_START + excerptDuration + 30);
    });

    it("closes 7320 frames from start for 80-word excerpt at 30fps", () => {
      const excerptDuration = computeExcerptDuration(80, 30);
      const closingStart = computeClosingStart(excerptDuration);
      expect(closingStart).toBe(7320); // 90 + 7200 + 30
    });
  });

  describe("TOTAL_FRAMES calculation", () => {
    it("equals closingStart + 50 for full video duration", () => {
      const excerptDuration = computeExcerptDuration(80, 30);
      const closingStart = computeClosingStart(excerptDuration);
      const totalFrames = computeTotalFrames(closingStart);
      expect(totalFrames).toBe(closingStart + 50);
    });

    it("is 7370 frames for 80-word excerpt at 30fps", () => {
      const excerptDuration = computeExcerptDuration(80, 30);
      const closingStart = computeClosingStart(excerptDuration);
      const totalFrames = computeTotalFrames(closingStart);
      expect(totalFrames).toBe(7370); // 7320 + 50
    });
  });

  describe("parseExcerptWords", () => {
    it("limits excerpt to 80 words", () => {
      const longExcerpt = Array.from({ length: 100 }, (_, i) => `word${i}`).join(" ");
      const words = parseExcerptWords(longExcerpt);
      expect(words.length).toBe(80);
    });

    it("removes newlines", () => {
      const words = parseExcerptWords("hello\nworld\ntest");
      expect(words).toEqual(["hello", "world", "test"]);
    });

    it("filters empty strings", () => {
      const words = parseExcerptWords("  hello    world  ");
      expect(words).toEqual(["hello", "world"]);
    });
  });

  describe("fps prop passthrough", () => {
    it("computeExcerptDuration uses fps parameter", () => {
      const at30fps = computeExcerptDuration(60, 30);
      const at60fps = computeExcerptDuration(60, 60);
      // Higher fps means faster word reveal (same wpm, more frames per second)
      expect(at60fps).toBeGreaterThan(at30fps);
    });
  });
});
