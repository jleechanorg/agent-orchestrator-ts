#!/usr/bin/env node
/**
 * Generate one daily serialized-novel entry from local repo + PR activity aggregation.
 *
 * Usage:
 *   node scripts/novel/generate-daily-entry.mjs \
 *     --file novel/the-daily-lives-of-workers.md \
 *     --days 1
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function sh(cmd, args) {
  const r = spawnSync(cmd, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 4_000_000,
    env: process.env,
  });

  if (r.error) {
    throw r.error;
  }

  return {
    ok: r.status === 0,
    out: r.stdout?.toString().trim() || "",
    err: r.stderr?.toString().trim() || "",
  };
}

function parseLines(raw) {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function readNovelContext(filePath) {
  try {
    const raw = readFileSync(filePath, "utf8");
    const headings = parseLines(raw).filter((line) => line.startsWith("## "));
    return {
      totalHeadings: headings.length,
      recentHeadings: headings.slice(-5),
    };
  } catch (error) {
    return {
      totalHeadings: 0,
      recentHeadings: [],
      error: error.message,
    };
  }
}

function collectRepoActivity(daysWindow) {
  const since = new Date(Date.now() - daysWindow * 24 * 60 * 60 * 1000).toISOString();
  const shortDate = since.slice(0, 10);

  const commitLog = sh("git", ["log", `--since=${shortDate}`, "--pretty=format:%h %s", "-n", "8"]);
  const branch = sh("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  const latest = sh("git", ["rev-parse", "--short", "HEAD"]);

  // Fallback safely if gh isn't available in this run context.
  let openPrs = { ok: false, out: "" };
  let mergedPrs = { ok: false, out: "" };
  let runSummary = { ok: false, out: "" };

  try {
    openPrs = sh("gh", ["pr", "list", "--state", "open", "--json", "number,title,updatedAt", "--limit", "10"]);
  } catch {
    // gh not available; use fallback
  }

  try {
    mergedPrs = sh("gh", ["pr", "list", "--state", "merged", "--json", "number,title,mergedAt", "--limit", "10"]);
  } catch {
    // gh not available; use fallback
  }

  try {
    runSummary = sh("gh", [
      "run",
      "list",
      "--limit",
      "10",
      "--json",
      "name,status,conclusion,workflowName,updatedAt",
    ]);
  } catch {
    // gh not available; use fallback
  }

  return {
    since,
    branch: branch.ok ? branch.out : "unknown",
    latestCommit: latest.ok ? latest.out : "unknown",
    commits: parseLines(commitLog.ok ? commitLog.out : ""),
    openPrs: parseJsonArray(openPrs, []),
    mergedPrs: parseJsonArray(mergedPrs, []),
    runs: parseJsonArray(runSummary, []),
  };
}

function parseJsonArray(commandResult, fallback) {
  if (!commandResult?.ok || !commandResult.out) {
    return fallback;
  }
  try {
    const parsed = JSON.parse(commandResult.out);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function buildEvent(activity, novelState) {
  const prOpen = activity.openPrs;
  const prMerged = activity.mergedPrs;

  const topOpen = prOpen
    .slice(0, 3)
    .map((pr) => `#${pr.number}: ${pr.title}`)
    .join("; ");

  const topMerged = prMerged
    .slice(0, 3)
    .map((pr) => `#${pr.number}: ${pr.title}`)
    .join("; ");

  const recentRuns = activity.runs
    .filter((run) => run.status === "completed")
    .slice(0, 3)
    .map((run) => `${run.workflowName}: ${run.conclusion}`)
    .join("; ");

  const topics = [
    `branch ${activity.branch}`,
    `commits(${activity.commits.length})`,
    `open PRs (${prOpen.length})${topOpen ? `: ${topOpen}` : ""}`,
    `recent merges (${prMerged.length})${topMerged ? `: ${topMerged}` : ""}`,
    recentRuns ? `recent checks: ${recentRuns}` : "",
    novelState.totalHeadings ? `novel log depth ${novelState.totalHeadings}` : "no novel context yet",
  ].filter(Boolean);

  const topic = topics.join(" | ");
  const lines = [];
  if (activity.commits.length > 0) {
    lines.push("Recent commits:");
    lines.push(...activity.commits.map((c) => `- ${c}`));
  }

  if (novelState.recentHeadings.length > 0) {
    lines.push("Recent novel headings:");
    lines.push(...novelState.recentHeadings.map((h) => `- ${h}`));
  }

  return {
    worker: `ao-novel-daily-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`,
    trigger: "daily_repo_aggregation",
    topic,
    context: lines.join(" ") || "automated daily aggregation",
  };
}

function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      file: { type: "string", default: "novel/the-daily-lives-of-workers.md" },
      days: { type: "string", default: "1" },
      words: { type: "string", default: "1000" },
    },
  });

  const file = values.file;
  const days = Number.parseInt(values.days, 10);
  const words = Number.parseInt(values.words, 10);

  const novelPath = path.resolve(REPO_ROOT, file);
  if (!existsSync(novelPath)) {
    writeFileSync(novelPath, "# The Daily Lives of Workers\n\n", "utf8");
  }

  const activity = collectRepoActivity(Number.isNaN(days) ? 1 : days);
  const novelState = readNovelContext(novelPath);
  const event = buildEvent(activity, novelState);

  const tempDir = mkdtempSync(path.join(tmpdir(), "ao-novel-"));
  try {
    const eventsFile = path.join(tempDir, "events.json");
    const payload = [event];
    writeFileSync(eventsFile, JSON.stringify(payload, null, 2), "utf8");

    const backfill = sh(
      "node",
      [
        path.join(REPO_ROOT, "scripts", "novel", "backfill-entries.mjs"),
        "--file",
        file,
        "--events",
        eventsFile,
        "--count",
        "1",
        "--words",
        String(Number.isNaN(words) ? 1000 : words),
        "--date-prefix",
        "Daily ",
      ]
    );

    if (!backfill.ok) {
      throw new Error(backfill.err || "backfill script failed");
    }

    console.log(backfill.out);
    console.log(`Daily novel entry generated for ${event.worker}.`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

main();
