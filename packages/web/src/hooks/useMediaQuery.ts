"use client";

import { useState, useEffect } from "react";

export const MOBILE_BREAKPOINT = 768;

export function useMediaQuery(breakpoint: number): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const query = window.matchMedia(`(max-width: ${breakpoint}px)`);
    setMatches(query.matches);
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    query.addEventListener("change", handler);
    return () => query.removeEventListener("change", handler);
  }, [breakpoint]);

  return matches;
}
