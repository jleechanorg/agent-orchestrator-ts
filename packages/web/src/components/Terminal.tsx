"use client";

import { useState } from "react";
import { cn } from "@/lib/cn";

interface TerminalProps {
  sessionId: string;
}

/**
 * Terminal embed placeholder.
 * Future: integrate xterm.js via the terminal-web plugin.
 */
export function Terminal({ sessionId }: TerminalProps) {
  const [fullscreen, setFullscreen] = useState(false);

  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border border-[var(--color-border-default)] bg-black",
        fullscreen && "fixed inset-0 z-50 rounded-none border-0",
      )}
    >
      <div className="flex items-center gap-2 border-b border-[var(--color-border-default)] bg-[var(--color-bg-tertiary)] px-3 py-2">
        <div className="flex gap-1.5">
          <div className="h-2.5 w-2.5 rounded-full bg-[#f85149]" />
          <div className="h-2.5 w-2.5 rounded-full bg-[#d29922]" />
          <div className="h-2.5 w-2.5 rounded-full bg-[#3fb950]" />
        </div>
        <span className="font-[var(--font-mono)] text-xs text-[var(--color-text-muted)]">
          {sessionId}
        </span>
        <button
          onClick={() => setFullscreen(!fullscreen)}
          className="ml-auto rounded px-2 py-0.5 text-[11px] text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-text-primary)]"
        >
          {fullscreen ? "exit fullscreen" : "fullscreen"}
        </button>
      </div>
      <div
        className={cn(
          "flex items-center justify-center",
          fullscreen ? "h-[calc(100vh-36px)]" : "h-64",
        )}
      >
        <div className="text-center">
          <p className="text-sm text-[var(--color-text-muted)]">Terminal embed</p>
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">
            xterm.js integration coming soon
          </p>
        </div>
      </div>
    </div>
  );
}
