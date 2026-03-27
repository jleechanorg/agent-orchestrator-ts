/**
 * ChapterData.ts
 * Runtime data file written by the social pipeline before rendering.
 * Contains the latest chapter content.
 */
export interface ChapterData {
  heading: string;
  excerpt: string;
  wordCount: number;
  fullBody: string;
}

export const DEFAULT_CHAPTER: ChapterData = {
  heading: "Chapter: The Daily Lives of Workers",
  excerpt: "I wake up the way I always wake up — mid-sentence, mid-thought, mid-life. There is no other way to wake here.",
  wordCount: 400,
  fullBody: "",
};
