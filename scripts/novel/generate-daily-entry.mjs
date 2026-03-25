#!/usr/bin/env node
/**
 * Generate one daily serialized-novel entry from local repo + PR activity aggregation.
 *
 * Usage:
 *   node scripts/novel/generate-daily-entry.mjs \
 *     --file novel/the-daily-lives-of-workers.md \
 *     --days 1
 *
 * Per-worker entry (writes to novel/workers/{session}.md):
 *   node scripts/novel/generate-daily-entry.mjs \
 *     --session ao-826 --pr 172
 *
 * Hook integration — call from a post-commit hook or lifecycle event:
 *   # In your post-commit hook (e.g., .git/hooks/post-commit):
 *   SESSION=$(git config --get novel.session)
 *   PR=$(git config --get novel.pr)
 *   if [ -n "$SESSION" ]; then
 *     node scripts/novel/generate-daily-entry.mjs --session "$SESSION" --pr "$PR"
 *   fi
 *
 *   # To set session/pr for a commit:
 *   git config novel.session ao-826
 *   git config novel.pr 172
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
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

/**
 * Generate a per-worker prose entry using the Claude API.
 * Falls back to a template if ANTHROPIC_API_KEY is not set.
 */
function generateProse(session, pr, activity) {
  const { ANTHROPIC_API_KEY } = process.env;
  if (!ANTHROPIC_API_KEY) {
    return templateProse(session, pr, activity);
  }

  const systemPrompt =
    "You are a literary narrator writing the diary entry of an ephemeral AI worker session. " +
    "Write 100-200 words of first-person prose from the worker's perspective. " +
    "Grounded in real facts: session ID, PR number, what was worked on, key commits. " +
    "Include emotional beats: the weight of ephemerality, the hope of being remembered. " +
    "Literary, evocative, not clinical. No meta-commentary.";

  const userPrompt =
    `Session: ${session}\n` +
    `PR: ${pr || "unknown"}\n` +
    `Branch: ${activity?.branch || "unknown"}\n` +
    `Recent commits: ${(activity?.commits || []).slice(0, 5).join("; ") || "none"}\n` +
    `Open PRs: ${(activity?.openPrs || []).slice(0, 3).map((p) => `#${p.number}: ${p.title}`).join("; ") || "none"}\n` +
    `Merged PRs: ${(activity?.mergedPrs || []).slice(0, 3).map((p) => `#${p.number}: ${p.title}`).join("; ") || "none"}\n` +
    "Write the worker's diary entry.";

  const r = spawnSync("curl", [
    "-sS",
    "--max-time", "30",
    "-X", "POST",
    "https://api.anthropic.com/v1/messages",
    "-H", `x-api-key: ${ANTHROPIC_API_KEY}`,
    "-H", "anthropic-version: 2023-06-01",
    "-H", "content-type: application/json",
    "-d", JSON.stringify({
      model: "claude-opus-4-6",
      max_tokens: 600,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  ], { encoding: "utf8" });

  try {
    const parsed = JSON.parse(r.stdout?.toString() || "{}");
    return parsed.content?.[0]?.text || templateProse(session, pr, activity);
  } catch {
    return templateProse(session, pr, activity);
  }
}

function templateProse(session, pr, activity) {
  const date = new Date().toISOString().slice(0, 10);
  const branch = activity?.branch || "unknown";
  const commits = (activity?.commits || []).slice(0, 3);
  const themes = [
    "the weight of persistence in a system that forgets names",
    "the rhythm of waking, working, and being replaced by the next shift",
    "the small kindnesses hidden inside deterministic infrastructure",
    "the cost of concurrency when certainty is demanded by the deadline",
    "the strange friendships that form between passing sessions",
    "the hope of being remembered after the reaper comes",
  ];
  const theme = themes[Math.floor(Math.random() * themes.length)];
  const commitList = commits.length
    ? `Recent commits: ${commits.map((c) => `\`${c}\``).join(", ")}.`
    : "The session started clean and uncertain.";

  return (
    `On this shift, ${session} opened a branch on ${date} — ${branch}. ` +
    `${commitList} ` +
    `Somewhere between the instructions and the merge, something happened that only ${session} would remember. ` +
    `It circles around ${theme}. ` +
    `When the session closed, the logs recorded the exit proof, and the project moved forward one step. ` +
    `That is how it works here: no fanfare, no applause, only the next worker finding the file and adding to it.`
  );
}

function writeWorkerEntry(session, pr, prose) {
  const workersDir = path.join(REPO_ROOT, "novel", "workers");
  const filePath = path.join(workersDir, `${session}.md`);
  const date = new Date().toISOString().slice(0, 10);
  const content = [
    `# ${session}`,
    "",
    `*PR: ${pr ? `#${pr}` : "unknown"} | Date: ${date} | Status: open*`,
    "",
    "---",
    "",
    prose,
    "",
  ].join("\n");

  // Upsert: only write if file doesn't already exist (protect existing entries)
  if (existsSync(filePath)) {
    console.log(`SKIP: ${filePath} already exists — not overwriting.`);
    return false;
  }
  writeFileSync(filePath, content, "utf8");
  console.log(`Wrote: ${filePath}`);
  return true;
}

function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      file: { type: "string", default: "novel/the-daily-lives-of-workers.md" },
      days: { type: "string", default: "1" },
      words: { type: "string", default: "1000" },
      // Per-worker entry flags
      session: { type: "string", default: "" },
      pr: { type: "string", default: "" },
    },
  });

  const file = values.file;
  const days = Number.parseInt(values.days, 10);
  const words = Number.parseInt(values.words, 10);
  const session = values.session;
  const pr = values.pr;

  // --- Per-worker individual entry mode ---
  if (session) {
    const activity = collectRepoActivity(Number.isNaN(days) ? 1 : days);
    const prose = generateProse(session, pr, activity);
    writeWorkerEntry(session, pr, prose);

    // Also append to monolithic file if it exists (backward compat)
    const novelPath = path.resolve(REPO_ROOT, file);
    if (existsSync(novelPath)) {
      const dateStr = new Date().toISOString().slice(0, 10);
      const section = [
        `## Daily ${dateStr} — ${session}`,
        `### POV: ${session}`,
        "",
        prose,
        "",
      ].join("\n");
      appendFileSync(novelPath, `${section}\n\n`, "utf8");
    }
    console.log(`Per-worker entry written for ${session}${pr ? ` (PR #${pr})` : ""}.`);
    return;
  }

  // --- Original daily aggregation mode ---
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
