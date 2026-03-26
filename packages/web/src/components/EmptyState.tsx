// EmptyState component — mirrors upstream's implementation, used when all kanban levels are empty
import type { ReactNode } from "react";

interface EmptyStateProps {
  message?: ReactNode;
}

export function EmptyState({ message }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <svg
        className="mb-4 h-8 w-8 text-[var(--color-border-strong)]"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <rect x="2" y="4" width="20" height="16" rx="2" />
        <path d="M6 9l4 3-4 3M13 15h5" />
      </svg>
      <p className="text-[13px] text-[var(--color-text-muted)]">
        {message ?? (
          <>
            No sessions running. Start one with{" "}
            <code className="font-[var(--font-mono)] text-[var(--color-text-secondary)]">
              ao start
            </code>
          </>
        )}
      </p>
    </div>
  );
}
