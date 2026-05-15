"use client";

import { useEffect, useRef, useState } from "react";
import { type DashboardPR, isPRMergeReady, isPRRateLimited } from "@/lib/types";
import { CI_STATUS } from "@jleechanorg/ao-core/types";
import { CIBadge, CICheckList } from "./CIBadge";
import { cn } from "@/lib/cn";

function cleanBugbotComment(body: string): { title: string; description: string } {
  const isBugbot = body.includes("<!-- DESCRIPTION START -->") || body.includes("### ");
  if (isBugbot) {
    const titleMatch = body.match(/###\s+(.+?)(?:\n|$)/);
    const title = titleMatch ? titleMatch[1].replace(/\*\*/g, "").trim() : "Comment";
    const descMatch = body.match(
      /<!-- DESCRIPTION START -->\s*([\s\S]*?)\s*<!-- DESCRIPTION END -->/,
    );
    const description = descMatch ? descMatch[1].trim() : body.split("\n")[0] || "No description";
    return { title, description };
  }
  return { title: "Comment", description: body.trim() };
}

async function askAgentToFix(
  sessionId: string,
  comment: { url: string; path: string; body: string },
  onSuccess: () => void,
  onError: () => void,
) {
  try {
    const { title, description } = cleanBugbotComment(comment.body);
    const message = `Please address this review comment:\n\nFile: ${comment.path}\nComment: ${title}\nDescription: ${description}\n\nComment URL: ${comment.url}\n\nAfter fixing, mark the comment as resolved at ${comment.url}`;
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    onSuccess();
  } catch (err) {
    console.error("Failed to send message to agent:", err);
    onError();
  }
}

interface PRCardProps {
  pr: DashboardPR;
  sessionId?: string;
  muted?: boolean;
}

export function PRCard({ pr, sessionId, muted }: PRCardProps) {
  const [sendingComments, setSendingComments] = useState<Set<string>>(new Set());
  const [sentComments, setSentComments] = useState<Set<string>>(new Set());
  const [errorComments, setErrorComments] = useState<Set<string>>(new Set());
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    return () => {
      timersRef.current.forEach((timer) => clearTimeout(timer));
      timersRef.current.clear();
    };
  }, []);

  const handleAskAgentToFix = async (comment: { url: string; path: string; body: string }) => {
    if (!sessionId) return;
    setSentComments((prev) => {
      const next = new Set(prev);
      next.delete(comment.url);
      return next;
    });
    setErrorComments((prev) => {
      const next = new Set(prev);
      next.delete(comment.url);
      return next;
    });
    setSendingComments((prev) => new Set(prev).add(comment.url));

    await askAgentToFix(
      sessionId,
      comment,
      () => {
        setSendingComments((prev) => {
          const next = new Set(prev);
          next.delete(comment.url);
          return next;
        });
        setSentComments((prev) => new Set(prev).add(comment.url));
        const existing = timersRef.current.get(comment.url);
        if (existing) clearTimeout(existing);
        const timer = setTimeout(() => {
          setSentComments((prev) => {
            const next = new Set(prev);
            next.delete(comment.url);
            return next;
          });
          timersRef.current.delete(comment.url);
        }, 3000);
        timersRef.current.set(comment.url, timer);
      },
      () => {
        setSendingComments((prev) => {
          const next = new Set(prev);
          next.delete(comment.url);
          return next;
        });
        setErrorComments((prev) => new Set(prev).add(comment.url));
        const existing = timersRef.current.get(comment.url);
        if (existing) clearTimeout(existing);
        const timer = setTimeout(() => {
          setErrorComments((prev) => {
            const next = new Set(prev);
            next.delete(comment.url);
            return next;
          });
          timersRef.current.delete(comment.url);
        }, 3000);
        timersRef.current.set(comment.url, timer);
      },
    );
  };

  const allGreen = isPRMergeReady(pr);
  const failedChecks = pr.ciChecks.filter((c) => c.status === "failed");

  const borderColor = allGreen
    ? "rgba(63,185,80,0.4)"
    : pr.state === "merged"
      ? "rgba(163,113,247,0.3)"
      : "var(--color-border-default)";

  return (
    <div
      className={cn(
        "detail-card mb-6 overflow-hidden rounded-[8px] border",
        muted && "opacity-70",
      )}
      style={{ borderColor }}
    >
      <div className="border-b border-[var(--color-border-subtle)] px-5 py-3.5">
        <a
          href={pr.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[13px] font-semibold text-[var(--color-text-primary)] transition-colors hover:text-[var(--color-accent)] hover:no-underline"
        >
          PR #{pr.number}: {pr.title}
        </a>
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px]">
          <span>
            <span className="text-[var(--color-status-ready)]">+{pr.additions}</span>{" "}
            <span className="text-[var(--color-status-error)]">-{pr.deletions}</span>
          </span>
          {pr.isDraft && (
            <>
              <span className="text-[var(--color-text-tertiary)]">&middot;</span>
              <span className="font-medium text-[var(--color-text-tertiary)]">Draft</span>
            </>
          )}
          {pr.state === "merged" && (
            <>
              <span className="text-[var(--color-text-tertiary)]">&middot;</span>
              <span
                className="rounded-full px-2 py-0.5 text-[10px] font-semibold"
                style={{ color: "#a371f7", background: "rgba(163,113,247,0.12)" }}
              >
                Merged
              </span>
            </>
          )}
        </div>
      </div>

      <div className="px-5 py-4">
        {allGreen ? (
          <div className="flex items-center gap-2 rounded-[5px] border border-[rgba(63,185,80,0.25)] bg-[rgba(63,185,80,0.07)] px-3.5 py-2.5">
            <svg
              className="h-4 w-4 shrink-0 text-[var(--color-status-ready)]"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              viewBox="0 0 24 24"
            >
              <path d="M20 6L9 17l-5-5" />
            </svg>
            <span className="text-[13px] font-semibold text-[var(--color-status-ready)]">
              Ready to merge
            </span>
          </div>
        ) : (
          <IssuesList pr={pr} />
        )}

        {pr.ciChecks.length > 0 && (
          <div className="mt-4 border-t border-[var(--color-border-subtle)] pt-4">
            <CICheckList
              checks={pr.ciChecks}
              layout={failedChecks.length > 0 ? "expanded" : "inline"}
            />
          </div>
        )}

        {pr.unresolvedComments.length > 0 && (
          <div className="mt-4 border-t border-[var(--color-border-subtle)] pt-4">
            <h4 className="mb-2.5 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
              Unresolved Comments
              <span
                className="rounded-full px-1.5 py-0.5 text-[10px] font-bold normal-case tracking-normal"
                style={{ color: "#f85149", background: "rgba(248,81,73,0.12)" }}
              >
                {pr.unresolvedThreads}
              </span>
            </h4>
            <div className="space-y-1">
              {pr.unresolvedComments.map((c) => {
                const { title, description } = cleanBugbotComment(c.body);
                return (
                  <details key={c.url} className="group">
                    <summary className="flex cursor-pointer list-none items-center gap-2 rounded-[5px] px-2 py-1.5 text-[12px] transition-colors hover:bg-[rgba(255,255,255,0.04)]">
                      <svg
                        className="h-3 w-3 shrink-0 text-[var(--color-text-tertiary)] transition-transform group-open:rotate-90"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        viewBox="0 0 24 24"
                      >
                        <path d="M9 5l7 7-7 7" />
                      </svg>
                      <span className="font-medium text-[var(--color-text-secondary)]">
                        {title}
                      </span>
                      <span className="text-[var(--color-text-tertiary)]">· {c.author}</span>
                      <a
                        href={c.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="ml-auto text-[10px] text-[var(--color-accent)] hover:underline"
                      >
                        view →
                      </a>
                    </summary>
                    <div className="ml-5 mt-1 space-y-1.5 px-2 pb-2">
                      <div className="font-[var(--font-mono)] text-[10px] text-[var(--color-text-tertiary)]">
                        {c.path}
                      </div>
                      <p className="border-l-2 border-[var(--color-border-default)] pl-3 text-[12px] leading-relaxed text-[var(--color-text-secondary)]">
                        {description}
                      </p>
                      {sessionId && (
                        <button
                          onClick={() => handleAskAgentToFix(c)}
                          disabled={sendingComments.has(c.url)}
                          className={cn(
                            "mt-1.5 rounded-[4px] px-3 py-1 text-[11px] font-semibold transition-all",
                            sentComments.has(c.url)
                              ? "bg-[var(--color-status-ready)] text-white"
                              : errorComments.has(c.url)
                                ? "bg-[var(--color-status-error)] text-white"
                                : "bg-[var(--color-accent)] text-white hover:opacity-90 disabled:opacity-50",
                          )}
                        >
                          {sendingComments.has(c.url)
                            ? "Sending…"
                            : sentComments.has(c.url)
                              ? "Sent ✓"
                              : errorComments.has(c.url)
                                ? "Failed"
                                : "Ask Agent to Fix"}
                        </button>
                      )}
                    </div>
                  </details>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Issues list (pre-merge blockers) ─────────────────────────────────

function IssuesList({ pr }: { pr: DashboardPR }) {
  const issues: Array<{ icon: string; color: string; text: string }> = [];
  const rateLimited = isPRRateLimited(pr);

  if (rateLimited) {
    issues.push({
      icon: "○",
      color: "var(--color-text-tertiary)",
      text: "PR data not loaded (rate limited)",
    });
    return issues.length > 0 ? (
      <ul className="space-y-1.5">
        {issues.map((issue, i) => (
          <li key={i} className="flex items-center gap-2 text-[12px]" style={{ color: issue.color }}>
            <span>{issue.icon}</span>
            <span>{issue.text}</span>
          </li>
        ))}
      </ul>
    ) : null;
  }

  if (pr.ciStatus === CI_STATUS.FAILING) {
    const failCount = pr.ciChecks.filter((c) => c.status === "failed").length;
    issues.push({
      icon: "✗",
      color: "var(--color-status-error)",
      text:
        failCount > 0
          ? `CI failing — ${failCount} check${failCount !== 1 ? "s" : ""} failed`
          : "CI failing",
    });
  } else if (pr.ciStatus === CI_STATUS.PENDING) {
    issues.push({ icon: "●", color: "var(--color-status-attention)", text: "CI pending" });
  }

  if (pr.reviewDecision === "changes_requested") {
    issues.push({ icon: "✗", color: "var(--color-status-error)", text: "Changes requested" });
  } else if (!pr.mergeability.approved) {
    issues.push({
      icon: "○",
      color: "var(--color-text-tertiary)",
      text: "Not approved — awaiting reviewer",
    });
  }

  if (pr.state !== "merged" && !pr.mergeability.noConflicts) {
    issues.push({ icon: "✗", color: "var(--color-status-error)", text: "Merge conflicts" });
  }

  if (!pr.mergeability.mergeable && issues.length === 0) {
    issues.push({ icon: "○", color: "var(--color-text-tertiary)", text: "Not mergeable" });
  }

  return issues.length > 0 ? (
    <ul className="space-y-1.5">
      {issues.map((issue, i) => (
        <li key={i} className="flex items-center gap-2 text-[12px]" style={{ color: issue.color }}>
          <span>{issue.icon}</span>
          <span>{issue.text}</span>
        </li>
      ))}
    </ul>
  ) : null;
}

function getSizeLabel(additions: number, deletions: number): string {
  const size = additions + deletions;
  return size > 1000 ? "XL" : size > 500 ? "L" : size > 200 ? "M" : size > 50 ? "S" : "XS";
}

interface PRStatusProps {
  pr: DashboardPR;
}

export function PRStatus({ pr }: PRStatusProps) {
  const sizeLabel = getSizeLabel(pr.additions, pr.deletions);
  const rateLimited = isPRRateLimited(pr);

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {/* PR number */}
      <a
        href={pr.url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-[11px] font-medium text-[var(--color-accent)] underline-offset-2 hover:underline"
        onClick={(e) => e.stopPropagation()}
      >
        #{pr.number}
      </a>

      {/* Size — hide when rate limited (would show +0 -0 XS) */}
      {!rateLimited && (
        <span className="inline-flex items-center rounded-full bg-[rgba(125,133,144,0.08)] px-2 py-0.5 text-[10px] font-semibold text-[var(--color-text-muted)]">
          +{pr.additions} -{pr.deletions} {sizeLabel}
        </span>
      )}

      {/* Merged badge */}
      {pr.state === "merged" && (
        <span className="inline-flex items-center rounded-full bg-[rgba(163,113,247,0.1)] px-2 py-0.5 text-[10px] font-semibold text-[var(--color-accent-violet)]">
          merged
        </span>
      )}

      {/* Draft badge */}
      {pr.isDraft && pr.state === "open" && (
        <span className="inline-flex items-center rounded-full bg-[rgba(125,133,144,0.08)] px-2 py-0.5 text-[10px] font-semibold text-[var(--color-text-muted)]">
          draft
        </span>
      )}

      {/* CI status — only when we have real data */}
      {pr.state === "open" && !pr.isDraft && !rateLimited && (
        <CIBadge status={pr.ciStatus} checks={pr.ciChecks} />
      )}

      {/* Review decision (only for open PRs with real data) */}
      {pr.state === "open" && pr.reviewDecision === "approved" && !rateLimited && (
        <span className="inline-flex items-center rounded-full bg-[rgba(63,185,80,0.1)] px-2 py-0.5 text-[10px] font-semibold text-[var(--color-accent-green)]">
          approved
        </span>
      )}
    </div>
  );
}

interface PRTableRowProps {
  pr: DashboardPR;
  muted?: boolean;
}

export function PRTableRow({ pr, muted: _muted }: PRTableRowProps) {
  const sizeLabel = getSizeLabel(pr.additions, pr.deletions);
  const rateLimited = isPRRateLimited(pr);

  const reviewLabel = rateLimited
    ? "—"
    : pr.isDraft
      ? "draft"
      : pr.reviewDecision === "approved"
        ? "approved"
        : pr.reviewDecision === "changes_requested"
          ? "changes requested"
          : "needs review";

  const reviewClass = rateLimited
    ? "text-[var(--color-text-tertiary)]"
    : pr.isDraft
      ? "text-[var(--color-text-muted)]"
      : pr.reviewDecision === "approved"
        ? "text-[var(--color-accent-green)]"
        : pr.reviewDecision === "changes_requested"
          ? "text-[var(--color-accent-red)]"
          : "text-[var(--color-accent-yellow)]";

  return (
    <tr className="border-b border-[var(--color-border-muted)] hover:bg-[rgba(88,166,255,0.03)]">
      <td className="px-3 py-2.5 text-sm">
        <a href={pr.url} target="_blank" rel="noopener noreferrer" className="hover:underline">
          #{pr.number}
        </a>
      </td>
      <td className="max-w-[420px] truncate px-3 py-2.5 text-sm font-medium">{pr.title}</td>
      <td className="px-3 py-2.5 text-sm">
        {rateLimited ? (
          <span className="text-[var(--color-text-tertiary)]">—</span>
        ) : (
          <>
            <span className="text-[var(--color-accent-green)]">+{pr.additions}</span>{" "}
            <span className="text-[var(--color-accent-red)]">-{pr.deletions}</span>{" "}
            <span className="text-[var(--color-text-muted)]">{sizeLabel}</span>
          </>
        )}
      </td>
      <td className="px-3 py-2.5">
        {rateLimited ? (
          <span className="text-[var(--color-text-tertiary)]">—</span>
        ) : (
          <CIBadge status={pr.ciStatus} checks={pr.ciChecks} compact />
        )}
      </td>
      <td className={`px-3 py-2.5 text-xs font-semibold ${reviewClass}`}>{reviewLabel}</td>
      <td
        className={`px-3 py-2.5 text-center text-sm font-bold ${pr.unresolvedThreads > 0 ? "text-[var(--color-accent-red)]" : "text-[var(--color-border-default)]"}`}
      >
        {pr.unresolvedThreads}
      </td>
    </tr>
  );
}
