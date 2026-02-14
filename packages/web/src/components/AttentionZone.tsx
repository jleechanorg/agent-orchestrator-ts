"use client";

import { useState } from "react";
import type { DashboardSession, AttentionLevel } from "@/lib/types";
import { SessionCard } from "./SessionCard";

interface AttentionZoneProps {
  level: AttentionLevel;
  sessions: DashboardSession[];
  onSend?: (sessionId: string, message: string) => void;
  onKill?: (sessionId: string) => void;
  onMerge?: (prNumber: number) => void;
  onRestore?: (sessionId: string) => void;
}

const zoneConfig: Record<
  AttentionLevel,
  {
    label: string;
    description: string;
    color: string;
    defaultCollapsed: boolean;
  }
> = {
  merge: {
    label: "MERGE",
    description: "PRs ready to merge",
    color: "var(--color-accent-green)",
    defaultCollapsed: false,
  },
  respond: {
    label: "RESPOND",
    description: "Agents waiting for your input",
    color: "var(--color-accent-red)",
    defaultCollapsed: false,
  },
  review: {
    label: "REVIEW",
    description: "CI failures, changes requested, conflicts",
    color: "var(--color-accent-orange)",
    defaultCollapsed: false,
  },
  pending: {
    label: "PENDING",
    description: "Waiting on reviewer or CI",
    color: "var(--color-accent-yellow)",
    defaultCollapsed: false,
  },
  working: {
    label: "WORKING",
    description: "Agents working normally",
    color: "var(--color-accent-blue)",
    defaultCollapsed: true,
  },
  done: {
    label: "DONE",
    description: "Merged or terminated",
    color: "var(--color-text-muted)",
    defaultCollapsed: true,
  },
};

export function AttentionZone({
  level,
  sessions,
  onSend,
  onKill,
  onMerge,
  onRestore,
}: AttentionZoneProps) {
  const config = zoneConfig[level];
  const [collapsed, setCollapsed] = useState(config.defaultCollapsed);

  if (sessions.length === 0) return null;

  return (
    <div className="mb-6">
      <button
        className="mb-2 flex w-full items-center gap-3 px-1 text-left"
        onClick={() => setCollapsed(!collapsed)}
      >
        <span
          className="text-xs font-bold uppercase tracking-widest"
          style={{ color: config.color }}
        >
          {config.label}
        </span>
        <span className="text-xs text-[var(--color-text-muted)]">{config.description}</span>
        <span
          className="ml-auto rounded-full px-2 py-0.5 text-xs font-bold"
          style={{
            color: config.color,
            background: `color-mix(in srgb, ${config.color} 10%, transparent)`,
          }}
        >
          {sessions.length}
        </span>
        <span className="text-xs text-[var(--color-text-muted)]">
          {collapsed ? "\u25B6" : "\u25BC"}
        </span>
      </button>

      {!collapsed && (
        <div className="space-y-2">
          {sessions.map((session) => (
            <SessionCard
              key={session.id}
              session={session}
              onSend={onSend}
              onKill={onKill}
              onMerge={onMerge}
              onRestore={onRestore}
            />
          ))}
        </div>
      )}
    </div>
  );
}
