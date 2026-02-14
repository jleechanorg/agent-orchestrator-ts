"use client";

import { useState, useEffect } from "react";
import {
  type DashboardSession,
  type DashboardPR,
  getAttentionLevel,
} from "@/lib/types";
import { CICheckList } from "./CIBadge";
import { Terminal } from "./Terminal";

interface SessionDetailProps {
  session: DashboardSession;
}

// ── Helpers ──────────────────────────────────────────────────────────

const activityLabel: Record<string, { label: string; color: string }> = {
  active: { label: "Active", color: "var(--color-accent-green)" },
  idle: { label: "Idle", color: "var(--color-text-muted)" },
  waiting_input: { label: "Waiting for input", color: "var(--color-accent-yellow)" },
  blocked: { label: "Blocked", color: "var(--color-accent-red)" },
  exited: { label: "Exited", color: "var(--color-accent-red)" },
};

function levelColor(level: string): string {
  switch (level) {
    case "merge":
      return "var(--color-accent-green)";
    case "respond":
      return "var(--color-accent-red)";
    case "review":
      return "var(--color-accent-orange)";
    case "pending":
      return "var(--color-accent-yellow)";
    case "working":
      return "var(--color-accent-blue)";
    default:
      return "var(--color-text-muted)";
  }
}

/** Converts snake_case status enum to Title Case display string. */
function humanizeStatus(status: string): string {
  return status
    .replace(/_/g, " ")
    .replace(/\bci\b/gi, "CI")
    .replace(/\bpr\b/gi, "PR")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Converts ISO date string to relative time like "3h ago", "2m ago". Client-side only. */
function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** Builds a GitHub branch URL from PR owner/repo/branch. */
function buildGitHubBranchUrl(pr: DashboardPR): string {
  return `https://github.com/${pr.owner}/${pr.repo}/tree/${pr.branch}`;
}

/** Builds a GitHub repo URL from PR owner/repo. */
function buildGitHubRepoUrl(pr: DashboardPR): string {
  return `https://github.com/${pr.owner}/${pr.repo}`;
}

// ── Main Component ───────────────────────────────────────────────────

export function SessionDetail({ session }: SessionDetailProps) {
  const pr = session.pr;
  const level = getAttentionLevel(session);
  const activity = activityLabel[session.activity] ?? {
    label: session.activity,
    color: "var(--color-text-muted)",
  };

  return (
    <div className="min-h-screen">
      {/* Nav bar */}
      <nav className="border-b border-[var(--color-border-muted)] bg-[var(--color-bg-secondary)]">
        <div className="mx-auto flex max-w-[900px] items-center px-8 py-2">
          <a
            href="/"
            className="text-xs font-medium tracking-wide text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:no-underline"
          >
            &larr; Agent Orchestrator
          </a>
        </div>
      </nav>

      <div className="mx-auto max-w-[900px] px-8 py-6">
        {/* ── Header ─────────────────────────────────────────────── */}
        <div className="mb-6">
          {/* Session ID + badges */}
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold">{session.id}</h1>
            <span
              className="rounded-full px-2 py-0.5 text-xs font-semibold"
              style={{
                color: activity.color,
                background: `color-mix(in srgb, ${activity.color} 15%, transparent)`,
              }}
            >
              {activity.label}
            </span>
            <span
              className="rounded-full px-2 py-0.5 text-xs font-semibold uppercase"
              style={{
                color: levelColor(level),
                background: `color-mix(in srgb, ${levelColor(level)} 10%, transparent)`,
              }}
            >
              {level}
            </span>
          </div>

          {/* Summary */}
          {session.summary && (
            <p className="mt-2 text-sm text-[var(--color-text-secondary)]">{session.summary}</p>
          )}

          {/* Meta chips: project · branch · issue */}
          <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs">
            {pr ? (
              <a
                href={buildGitHubRepoUrl(pr)}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-md bg-[var(--color-bg-tertiary)] px-2 py-0.5 text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:no-underline"
              >
                {session.projectId}
              </a>
            ) : (
              <span className="rounded-md bg-[var(--color-bg-tertiary)] px-2 py-0.5 text-[var(--color-text-secondary)]">
                {session.projectId}
              </span>
            )}

            {session.branch && (
              <>
                <span className="text-[var(--color-text-muted)]">&middot;</span>
                {pr ? (
                  <a
                    href={buildGitHubBranchUrl(pr)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded-md bg-[var(--color-bg-tertiary)] px-2 py-0.5 font-[var(--font-mono)] text-[11px] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:no-underline"
                  >
                    {session.branch}
                  </a>
                ) : (
                  <span className="rounded-md bg-[var(--color-bg-tertiary)] px-2 py-0.5 font-[var(--font-mono)] text-[11px] text-[var(--color-text-secondary)]">
                    {session.branch}
                  </span>
                )}
              </>
            )}

            {session.issueId && (
              <>
                <span className="text-[var(--color-text-muted)]">&middot;</span>
                <span className="rounded-md bg-[var(--color-bg-tertiary)] px-2 py-0.5 text-[var(--color-text-secondary)]">
                  {session.issueId}
                </span>
              </>
            )}
          </div>

          {/* Status · timestamps */}
          <ClientTimestamps
            status={session.status}
            createdAt={session.createdAt}
            lastActivityAt={session.lastActivityAt}
          />
        </div>

        {/* ── PR Card ────────────────────────────────────────────── */}
        {pr && <PRCard pr={pr} />}

        {/* ── Terminal ───────────────────────────────────────────── */}
        <div className="mt-6">
          <h3 className="mb-3 text-[13px] font-semibold uppercase tracking-widest text-[var(--color-text-muted)]">
            Terminal
          </h3>
          <Terminal sessionId={session.id} />
        </div>
      </div>
    </div>
  );
}

// ── Client-side timestamps (avoids hydration mismatch) ───────────────

function ClientTimestamps({
  status,
  createdAt,
  lastActivityAt,
}: {
  status: string;
  createdAt: string;
  lastActivityAt: string;
}) {
  const [created, setCreated] = useState<string | null>(null);
  const [lastActive, setLastActive] = useState<string | null>(null);

  useEffect(() => {
    setCreated(relativeTime(createdAt));
    setLastActive(relativeTime(lastActivityAt));
  }, [createdAt, lastActivityAt]);

  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-2 text-xs text-[var(--color-text-muted)]">
      <span>{humanizeStatus(status)}</span>
      {created && (
        <>
          <span>&middot;</span>
          <span>Created {created}</span>
        </>
      )}
      {lastActive && (
        <>
          <span>&middot;</span>
          <span>Active {lastActive}</span>
        </>
      )}
    </div>
  );
}

// ── PR Card ──────────────────────────────────────────────────────────

function PRCard({ pr }: { pr: DashboardPR }) {
  const allGreen =
    pr.mergeability.mergeable &&
    pr.mergeability.ciPassing &&
    pr.mergeability.approved &&
    pr.mergeability.noConflicts;

  const failedChecks = pr.ciChecks.filter((c) => c.status === "failed");
  const hasFailures = failedChecks.length > 0;

  return (
    <div className="rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)]">
      {/* Title row */}
      <div className="border-b border-[var(--color-border-muted)] px-4 py-3">
        <a
          href={pr.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm font-medium text-[var(--color-text-primary)] hover:text-[var(--color-accent-blue)]"
        >
          PR #{pr.number}: {pr.title}
        </a>

        {/* Stats row */}
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px]">
          <span className="text-[var(--color-text-muted)]">
            <span className="text-[var(--color-accent-green)]">+{pr.additions}</span>{" "}
            <span className="text-[var(--color-accent-red)]">-{pr.deletions}</span>
          </span>

          {pr.isDraft && (
            <>
              <span className="text-[var(--color-text-muted)]">&middot;</span>
              <span className="font-semibold text-[var(--color-text-muted)]">Draft</span>
            </>
          )}

          {pr.state === "merged" && (
            <>
              <span className="text-[var(--color-text-muted)]">&middot;</span>
              <span className="font-semibold text-[var(--color-accent-violet)]">Merged</span>
            </>
          )}

          {pr.state === "open" && (
            <>
              <span className="text-[var(--color-text-muted)]">&middot;</span>
              <CIStatusInline status={pr.ciStatus} failedCount={failedChecks.length} />
              <span className="text-[var(--color-text-muted)]">&middot;</span>
              <ReviewStatusInline decision={pr.reviewDecision} />
            </>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="px-4 py-3">
        {/* Ready to merge or issues list */}
        {allGreen ? (
          <div className="flex items-center gap-2 text-xs">
            <span className="text-[var(--color-accent-green)]">{"\u2713"}</span>
            <span className="font-semibold text-[var(--color-accent-green)]">Ready to merge</span>
          </div>
        ) : (
          <IssuesList pr={pr} />
        )}

        {/* CI Checks — inline row */}
        {pr.ciChecks.length > 0 && (
          <div className="mt-3 border-t border-[var(--color-border-muted)] pt-3">
            <CICheckList checks={pr.ciChecks} layout={hasFailures ? "expanded" : "inline"} />
          </div>
        )}

        {/* Unresolved Comments */}
        {pr.unresolvedComments.length > 0 && (
          <div className="mt-3 border-t border-[var(--color-border-muted)] pt-3">
            <h4 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
              Unresolved Comments ({pr.unresolvedThreads})
            </h4>
            <div className="space-y-2">
              {pr.unresolvedComments.map((c) => (
                <div
                  key={c.url}
                  className="rounded-md border border-[var(--color-border-muted)] bg-[var(--color-bg-primary)] p-3"
                >
                  <div className="flex items-center gap-2 text-xs">
                    <span className="font-semibold text-[var(--color-text-secondary)]">
                      {c.author}
                    </span>
                    <span className="text-[var(--color-text-muted)]">on</span>
                    <a
                      href={c.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-[var(--font-mono)] text-[11px] text-[var(--color-accent-blue)] hover:underline"
                    >
                      {c.path}
                    </a>
                    <a
                      href={c.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ml-auto shrink-0 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-accent-blue)]"
                    >
                      view &rarr;
                    </a>
                  </div>
                  <p className="mt-1.5 border-l-2 border-[var(--color-border-default)] pl-2.5 text-xs leading-relaxed text-[var(--color-text-secondary)] italic">
                    {c.body}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Issues List (replaces merge readiness grid + blockers) ───────────

function IssuesList({ pr }: { pr: DashboardPR }) {
  const issues: Array<{ icon: string; color: string; text: string }> = [];

  if (pr.ciStatus === "failing") {
    const failCount = pr.ciChecks.filter((c) => c.status === "failed").length;
    issues.push({
      icon: "\u2717",
      color: "var(--color-accent-red)",
      text: `CI failing \u2014 ${failCount} check${failCount !== 1 ? "s" : ""} failed`,
    });
  } else if (pr.ciStatus === "pending") {
    issues.push({
      icon: "\u25CF",
      color: "var(--color-accent-yellow)",
      text: "CI pending",
    });
  }

  if (pr.reviewDecision === "changes_requested") {
    issues.push({
      icon: "\u2717",
      color: "var(--color-accent-red)",
      text: "Changes requested",
    });
  } else if (!pr.mergeability.approved) {
    issues.push({
      icon: "\u25CB",
      color: "var(--color-text-muted)",
      text: "Not approved \u2014 awaiting reviewer",
    });
  }

  if (!pr.mergeability.noConflicts) {
    issues.push({
      icon: "\u2717",
      color: "var(--color-accent-red)",
      text: "Merge conflicts",
    });
  }

  if (!pr.mergeability.mergeable && issues.length === 0) {
    issues.push({
      icon: "\u25CB",
      color: "var(--color-text-muted)",
      text: "Not mergeable",
    });
  }

  if (pr.unresolvedThreads > 0) {
    issues.push({
      icon: "\u25CF",
      color: "var(--color-accent-yellow)",
      text: `${pr.unresolvedThreads} unresolved comment${pr.unresolvedThreads !== 1 ? "s" : ""}`,
    });
  }

  if (pr.isDraft) {
    issues.push({
      icon: "\u25CB",
      color: "var(--color-text-muted)",
      text: "Draft PR",
    });
  }

  if (issues.length === 0) return null;

  return (
    <div className="space-y-1.5">
      <h4 className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
        Issues
      </h4>
      {issues.map((issue) => (
        <div key={issue.text} className="flex items-center gap-2 text-xs">
          <span style={{ color: issue.color }}>{issue.icon}</span>
          <span className="text-[var(--color-text-secondary)]">{issue.text}</span>
        </div>
      ))}
    </div>
  );
}

// ── Inline status pills ──────────────────────────────────────────────

function CIStatusInline({ status, failedCount }: { status: string; failedCount: number }) {
  if (status === "passing") {
    return <span className="font-semibold text-[var(--color-accent-green)]">{"\u2713"} CI passing</span>;
  }
  if (status === "failing") {
    return (
      <span className="font-semibold text-[var(--color-accent-red)]">
        {"\u2717"} {failedCount} check{failedCount !== 1 ? "s" : ""} failing
      </span>
    );
  }
  if (status === "pending") {
    return <span className="font-semibold text-[var(--color-accent-yellow)]">{"\u25CF"} CI pending</span>;
  }
  return null;
}

function ReviewStatusInline({ decision }: { decision: string }) {
  if (decision === "approved") {
    return <span className="font-semibold text-[var(--color-accent-green)]">{"\u2713"} Approved</span>;
  }
  if (decision === "changes_requested") {
    return (
      <span className="font-semibold text-[var(--color-accent-red)]">{"\u2717"} Changes requested</span>
    );
  }
  if (decision === "pending") {
    return (
      <span className="font-semibold text-[var(--color-accent-yellow)]">
        {"\u23F3"} Pending review
      </span>
    );
  }
  return <span className="text-[var(--color-text-muted)]">No review</span>;
}
