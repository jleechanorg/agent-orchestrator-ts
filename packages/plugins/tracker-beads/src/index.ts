/**
 * tracker-beads plugin — Beads (.beads/issues.jsonl) as an issue tracker.
 *
 * Reads the local .beads/issues.jsonl file to resolve bead IDs (bd-xxx)
 * into full task context for AO worker prompts.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  PluginModule,
  Tracker,
  Issue,
  IssueFilters,
  ProjectConfig,
} from "@jleechanorg/ao-core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BeadRecord {
  id: string;
  title: string;
  description?: string;
  status: string;
  priority?: number;
  issue_type?: string;
  dependencies?: Array<{ depends_on_id: string; type: string }>;
}

// ---------------------------------------------------------------------------
// JSONL reader
// ---------------------------------------------------------------------------

function loadBeads(projectPath: string): BeadRecord[] {
  const jsonlPath = resolve(projectPath, ".beads", "issues.jsonl");
  let content: string;
  try {
    content = readFileSync(jsonlPath, "utf-8");
  } catch {
    return [];
  }

  const records: BeadRecord[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as BeadRecord;
      if (parsed.id && parsed.status !== "tombstone") records.push(parsed);
    } catch {
      // Skip malformed lines
    }
  }
  return records;
}

function findBead(identifier: string, project: ProjectConfig): BeadRecord | undefined {
  const projectPath = project.path ?? ".";
  const beads = loadBeads(projectPath);
  return beads.find((b) => b.id === identifier);
}

// ---------------------------------------------------------------------------
// Tracker implementation
// ---------------------------------------------------------------------------

function mapStatus(status: string): Issue["state"] {
  switch (status) {
    case "closed":
    case "done":
      return "closed";
    case "in_progress":
    case "working":
      return "in_progress";
    case "cancelled":
    case "wontfix":
    case "tombstone":
      return "cancelled";
    default:
      return "open";
  }
}

function beadToIssue(bead: BeadRecord): Issue {
  return {
    id: bead.id,
    title: bead.title,
    description: bead.description ?? "",
    url: `beads://${bead.id}`,
    state: mapStatus(bead.status),
    labels: bead.issue_type ? [bead.issue_type] : [],
    priority: bead.priority,
  };
}

function createBeadsTracker(): Tracker {
  return {
    name: "beads",

    async getIssue(identifier: string, _project: ProjectConfig): Promise<Issue> {
      const bead = findBead(identifier, _project);
      if (!bead) {
        throw new Error(`Bead ${identifier} not found in .beads/issues.jsonl`);
      }
      return beadToIssue(bead);
    },

    async isCompleted(identifier: string, _project: ProjectConfig): Promise<boolean> {
      const bead = findBead(identifier, _project);
      if (!bead) return false;
      return bead.status === "closed" || bead.status === "done";
    },

    issueUrl(identifier: string, _project: ProjectConfig): string {
      return `beads://${identifier}`;
    },

    branchName(identifier: string, _project: ProjectConfig): string {
      return `feat/${identifier}`;
    },

    async generatePrompt(identifier: string, _project: ProjectConfig): Promise<string> {
      const projectPath = _project.path ?? ".";
      const allBeads = loadBeads(projectPath);
      const bead = allBeads.find((b) => b.id === identifier);

      if (!bead) {
        return `Work on bead: ${identifier}\n\nNote: Could not find bead details in .beads/issues.jsonl. Check if the bead ID is correct.`;
      }

      const desc = bead.description ?? "(no description)";
      const lines: string[] = [];
      lines.push(`## Bead: ${bead.id} — ${bead.title}`);
      lines.push("");
      lines.push(`**Priority:** P${bead.priority ?? "?"} | **Type:** ${bead.issue_type ?? "task"} | **Status:** ${bead.status}`);
      lines.push("");
      lines.push("### Description");
      lines.push(desc);

      if (bead.dependencies && bead.dependencies.length > 0) {
        lines.push("");
        lines.push("### Dependencies");
        for (const dep of bead.dependencies) {
          lines.push(`- ${dep.type}: ${dep.depends_on_id}`);
        }

        // Include parent/epic context (reuse already-loaded beads)
        const parentDep = bead.dependencies.find((d) => d.type === "blocks" || d.type === "parent-child");
        if (parentDep) {
          const parent = allBeads.find((b) => b.id === parentDep.depends_on_id);
          if (parent) {
            lines.push("");
            lines.push(`### Parent Epic: ${parent.id} — ${parent.title}`);
            lines.push(parent.description ?? "(no description)");
          }
        }
      }

      return lines.join("\n");
    },

    async listIssues(filters: IssueFilters, _project: ProjectConfig): Promise<Issue[]> {
      const projectPath = _project.path ?? ".";
      const beads = loadBeads(projectPath);

      return beads
        .filter((b) => {
          if (filters.state && filters.state !== "all") {
            const mapped = mapStatus(b.status);
            if (filters.state === "open" && mapped !== "open" && mapped !== "in_progress") return false;
            if (filters.state === "closed" && mapped !== "closed") return false;
          }
          if (filters.labels && filters.labels.length > 0) {
            if (!b.issue_type || !filters.labels.includes(b.issue_type)) return false;
          }
          return true;
        })
        .slice(0, filters.limit ?? 50)
        .map(beadToIssue);
    },
  };
}

// ---------------------------------------------------------------------------
// Plugin module
// ---------------------------------------------------------------------------

export const manifest = {
  name: "beads",
  slot: "tracker" as const,
  description: "Tracker plugin: Beads issue tracker (.beads/issues.jsonl)",
  version: "0.1.0",
};

export function create(): Tracker {
  return createBeadsTracker();
}

export default { manifest, create } satisfies PluginModule<Tracker>;
