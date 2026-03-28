#!/usr/bin/env node
/**
 * scripts/generate-pr-design-docs.mjs
 *
 * Generates .md and .html design doc files for all AO-managed PRs in
 * jleechanorg/agent-orchestrator, following the PR #592 template format.
 *
 * Usage:
 *   node scripts/generate-pr-design-docs.mjs [--repo OWNER/REPO] [--force] [--dry-run] [--limit N]
 *
 * Output:
 *   docs/design/pr-designs/pr-{number}.md
 *   docs/design/pr-designs/pr-{number}.html
 */

import { writeFileSync, mkdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [k, v] = arg.replace(/^--/, "").split("=");
    return [k, v ?? true];
  })
);

const REPO = args.repo ?? "jleechanorg/agent-orchestrator";
const FORCE = args.force === true;
const DRY_RUN = args["dry-run"] === true;
const LIMIT = args.limit ? parseInt(args.limit, 10) : Infinity;
let SINGLE_PR = null;
if ("single-pr" in args) {
  const parsed = parseInt(String(args["single-pr"]), 10);
  if (Number.isNaN(parsed)) {
    console.error(`Invalid --single-pr value: ${args["single-pr"]}. Expected a numeric PR number.`);
    process.exit(1);
  }
  SINGLE_PR = parsed;
}

// ---------------------------------------------------------------------------
// GitHub REST helpers
// ---------------------------------------------------------------------------

/**
 * Call `gh api repos/{owner}/{repo}/...` using the gh CLI (respects token, etc.)
 */
async function ghApi(path, jqFilter = null) {
  const cmd = ["gh", "api", `repos/${REPO}/${path}`];
  if (jqFilter) cmd.push("--jq", jqFilter);
  const { stdout } = await run(cmd);
  try {
    return JSON.parse(stdout);
  } catch {
    return stdout.trim();
  }
}

import { spawn } from "node:child_process";

function run(cmd) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd[0], cmd.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (err += d));
    proc.on("close", (code) => {
      if (code === 0) resolve({ stdout: out, stderr: err });
      else reject(new Error(`Command failed: ${cmd.join(" ")}\n${err}`));
    });
    proc.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Fetch all PRs
// ---------------------------------------------------------------------------

async function fetchAllPRs() {
  // Fetch merged + open + closed to capture all
  const states = ["open", "closed"];
  const allPRs = [];

  for (const state of states) {
    let page = 1;
    while (true) {
      const prs = await ghApi(
        `pulls?state=${state}&per_page=100&page=${page}&sort=created&direction=desc`,
        null
      );
      if (!Array.isArray(prs) || prs.length === 0) break;
      allPRs.push(...prs.map((p) => ({ ...p, _fetched_state: state })));
      if (prs.length < 100) break;
      page++;
      if (page > 20) break; // safety cap
    }
  }
  return allPRs;
}

async function fetchPRFiles(prNumber) {
  let page = 1;
  const files = [];
  while (true) {
    const f = await ghApi(
      `pulls/${prNumber}/files?per_page=100&page=${page}`,
      null
    );
    if (!Array.isArray(f) || f.length === 0) break;
    files.push(...f);
    if (f.length < 100) break;
    page++;
  }
  return files;
}

async function fetchPRCommits(prNumber) {
  let page = 1;
  const commits = [];
  while (true) {
    const c = await ghApi(
      `pulls/${prNumber}/commits?per_page=100&page=${page}`,
      null
    );
    if (!Array.isArray(c) || c.length === 0) break;
    commits.push(...c);
    if (c.length < 100) break;
    page++;
  }
  return commits;
}

// ---------------------------------------------------------------------------
// AO-managed PR detection
// ---------------------------------------------------------------------------

function isAOManaged(pr) {
  const title = (pr.title || "").toLowerCase();
  const branch = (pr.head?.ref || "").toLowerCase();
  const labels = (pr.labels || []).map((l) =>
    typeof l === "string" ? l : l.name
  ).map((l) => l.toLowerCase());

  return (
    title.includes("[agento]") ||
    /^(feat|fix|chore|docs|test|refactor)\/((orch|ao|bd|wc|jc|ra|cc)-|[a-z]{2,4}-)/.test(branch) ||
    labels.some((l) => l.includes("agento") || l.includes("autonomous"))
  );
}

// ---------------------------------------------------------------------------
// Template helpers
// ---------------------------------------------------------------------------

function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

function stateLabel(state, _mergedAt) {
  if (state === "merged") return '<span class="badge badge-merged">Merged</span>';
  if (state === "closed") return '<span class="badge badge-closed">Closed</span>';
  return '<span class="badge badge-open">Open</span>';
}

function mdStateLabel(state, _mergedAt) {
  if (state === "merged") return "**Merged**";
  if (state === "closed") return "~~**Closed**~~";
  return "**Open**";
}

function fileCountByPrefix(files) {
  const counts = {};
  for (const f of files) {
    const parts = f.filename.split("/");
    const prefix = parts.length > 2 ? parts.slice(0, 2).join("/") : parts[0];
    counts[prefix] = (counts[prefix] || 0) + 1;
  }
  return counts;
}

function extractDescription(body) {
  if (!body) return "No description provided.";
  // Use first paragraph (non-empty, non-heading line block)
  // bd-7gs-fix: strip HTML comment markers and adjacent markdown separators from AI-generated PR bodies
  const cleaned = (body || "")
    .replace(/<!--\s*CURSOR_SUMMARY\s*-->/gi, "")
    .replace(/^---\s*$/gm, "")
    .replace(/<!--[\s\S]*?-->/g, ""); // strip all HTML comments
  const paragraphs = cleaned.split(/\n\n+/);
  for (const p of paragraphs) {
    const trimmed = p.trim();
    if (trimmed && !trimmed.startsWith("#") && trimmed.length > 20) {
      return trimmed.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1"); // strip links
    }
  }
  return cleaned.slice(0, 200).trim() + "…";
}

function extractLabels(pr) {
  return (pr.labels || [])
    .map((l) => (typeof l === "string" ? l : l.name))
    .filter(Boolean);
}

function archDiagram(pr) {
  const title = pr.title.replace(/^\[agento\]\s*/i, "");
  const prNum = pr.number;
  // Compute box width from longest content line so no title gets truncated
  const lines = [
    `PR #${prNum} — agent-orchestrator`,
    title,
    `${pr.files.length} file(s) changed`,
  ];
  const W = Math.max(...lines.map(l => l.length)) + 4;
  const bar = "─".repeat(W);
  const pad = (s) => s.padEnd(W);
  // Use string concatenation to avoid nested template literal parse ambiguity
  const archHeader = "│ " + pad("PR #" + prNum + " — agent-orchestrator") + " │";
  const archTitle  = "│ " + pad(title) + " │";
  return "┌" + bar + " ┐\n" + archHeader + "\n" +
    "└" + bar + " ┘\n                  │\n    ▼ " + pr.files.length +
    " file(s) changed\n                  │\n" +
    "┌" + bar + " ┐\n" + archTitle + "\n└" + bar + " ┘";
}

// ---------------------------------------------------------------------------
// HTML template
// ---------------------------------------------------------------------------

function htmlDoc({ pr, files, commits }) {
  const title = pr.title || "Untitled PR";
  const description = extractDescription(pr.body);
  const mergedAt = pr.merged_at || pr.merge_commit_sha ? pr.merged_at : null;
  const state = mergedAt ? "merged" : pr.state;
  const date = mergedAt || pr.created_at;
  const labels = extractLabels(pr);

  const filesByPrefix = fileCountByPrefix(files || []);
  const totalAdditions = (files || []).reduce((s, f) => s + (f.additions || 0), 0);
  const totalDeletions = (files || []).reduce((s, f) => s + (f.deletions || 0), 0);

  const diagram = archDiagram({ ...pr, files });

  const labelBadges = labels
    .map(
      (l) =>
        `<span class="badge badge-shared">${escHtml(l)}</span>`
    )
    .join(" ");

  const fileRows = (files || [])
    .slice(0, 50)
    .map(
      (f) => `<tr>
      <td><code>${escHtml(f.filename)}</code></td>
      <td>${f.status === "added" ? '<span class="badge badge-new">added</span>' : f.status === "removed" ? '<span class="badge badge-closed">removed</span>' : f.status}</td>
      <td style="text-align:right;color:#2ea043">+${f.additions ?? 0}</td>
      <td style="text-align:right;color:#cf222e">-${f.deletions ?? 0}</td>
    </tr>`
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escHtml(title)} — Agent Orchestrator</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600&family=IBM+Plex+Serif:wght@400;600&family=IBM+Plex+Mono&display=swap" rel="stylesheet" />
    <style>
      :root {
        --bg: #f2efe7;
        --panel: #fffdf8;
        --ink: #1f1a16;
        --muted: #6f6357;
        --brand: #165a72;
        --line: #dfd3c2;
      }
      * { box-sizing: border-box; }
      body { margin: 0; color: var(--ink); font-family: "IBM Plex Sans", "Segoe UI", sans-serif; line-height: 1.5; background: radial-gradient(circle at 12% 10%, #ebdfcb 0%, transparent 35%), radial-gradient(circle at 88% 85%, #e5d4ba 0%, transparent 30%), var(--bg); }
      .wrap { max-width: 1100px; margin: 2rem auto; padding: 0 1rem 3rem; }
      .hero, .card { border: 1px solid var(--line); border-radius: 14px; background: var(--panel); }
      .hero { padding: 1.2rem; }
      .card { padding: 1rem; margin-top: 1rem; }
      h1, h2, h3 { font-family: "IBM Plex Serif", Georgia, serif; margin: 0.6rem 0; }
      .muted { color: var(--muted); }
      .grid { margin-top: 1rem; display: grid; gap: 1rem; }
      @media (min-width: 900px) { .grid.two { grid-template-columns: repeat(2, minmax(0, 1fr)); } .grid.three { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
      ul, ol { margin: 0.4rem 0 0; padding-left: 1.2rem; }
      code { font-family: "IBM Plex Mono", "SFMono-Regular", monospace; background: #f3ebe0; border-radius: 4px; padding: 0.1rem 0.28rem; font-size: 0.85em; }
      pre { margin-top: 0.7rem; padding: 0.7rem; border: 1px solid var(--line); border-radius: 10px; background: #faf4ec; overflow-x: auto; }
      table { width: 100%; border-collapse: collapse; margin: 1rem 0; font-size: 0.88rem; }
      th { background: #f3ebe0; text-align: left; padding: 0.5rem 0.7rem; border: 1px solid var(--line); font-weight: 600; }
      td { padding: 0.5rem 0.7rem; border: 1px solid var(--line); vertical-align: top; }
      .badge { display: inline-block; padding: 0.1rem 0.4rem; border-radius: 6px; font-size: 0.75rem; font-weight: 600; margin-right: 0.3rem; }
      .badge-new { background: #3fb950; color: #000; }
      .badge-merged { background: #8250df; color: #fff; }
      .badge-closed { background: #6f6357; color: #fff; }
      .badge-open { background: #1f77ff; color: #fff; }
      .badge-shared { background: var(--brand); color: #fff; }
      .diagram { background: #faf4ec; border: 1px solid var(--line); border-radius: 10px; padding: 1rem; margin: 1rem 0; }
      .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 0.5rem; margin-top: 1rem; }
      .stat { background: #f3ebe0; border: 1px solid var(--line); border-radius: 8px; padding: 0.6rem; text-align: center; }
      .stat .num { font-size: 1.4rem; font-weight: 700; font-family: "IBM Plex Mono", monospace; }
      .stat .lbl { font-size: 0.72rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; }
      a { color: var(--brand); }
      .footer { margin-top: 2rem; padding-top: 1rem; border-top: 1px solid var(--line); color: var(--muted); font-size: 0.85rem; }
    </style>
  </head>
  <body>
    <main class="wrap">
      <section class="hero">
        <h1>${escHtml(title)}</h1>
        ${description.includes("\n")
          ? description.split("\n").filter(l => l.trim()).map(l => `<p class="muted">${escMd(l)}</p>`).join("\n")
          : `<p class="muted">${escHtml(description)}</p>`}
        <p class="muted" style="margin-top:0.5rem">
          PR: <a href="https://github.com/${REPO}/pull/${pr.number}">#${pr.number}</a>
          &nbsp;·&nbsp; Status: ${stateLabel(state, mergedAt)}
          &nbsp;·&nbsp; ${escHtml(formatDate(date))}
          ${labelBadges ? "&nbsp;·&nbsp;" + labelBadges : ""}
        </p>
      </section>

      <section class="grid two">
        <article class="card">
          <h2>Architecture</h2>
          <div class="diagram">
<pre>${escHtml(diagram)}</pre>
          </div>
        </article>
        <article class="card">
          <h2>Metadata</h2>
          <div class="stat-grid">
            <div class="stat"><div class="num">${(files || []).length}</div><div class="lbl">Files</div></div>
            <div class="stat"><div class="num">${(commits || []).length}</div><div class="lbl">Commits</div></div>
            <div class="stat"><div class="num" style="color:#2ea043">+${totalAdditions}</div><div class="lbl">Additions</div></div>
            <div class="stat"><div class="num" style="color:#cf222e">-${totalDeletions}</div><div class="lbl">Deletions</div></div>
          </div>
          <ul style="margin-top:1rem">
            <li>Author: <code>${escHtml(pr.user?.login || "unknown")}</code></li>
            <li>Created: ${formatDate(pr.created_at)}</li>
            ${mergedAt ? `<li>Merged: ${formatDate(mergedAt)}</li>` : ""}
            <li>Head branch: <code>${escHtml(pr.head?.ref || "")}</code></li>
          </ul>
        </article>
      </section>

      ${Object.keys(filesByPrefix).length > 0 ? `
      <section class="card">
        <h2>Files Changed (by package)</h2>
        <table>
          <thead><tr><th>Package / Path</th><th>Files</th></tr></thead>
          <tbody>
            ${Object.entries(filesByPrefix).sort((a, b) => b[1] - a[1]).map(
              ([path, count]) => `<tr><td><code>${escHtml(path)}</code></td><td>${count}</td></tr>`
            ).join("\n")}
          </tbody>
        </table>
      </section>` : ""}

      ${(files || []).length > 0 ? `
      <section class="card">
        <h2>All Files Changed</h2>
        <table>
          <thead><tr><th>File</th><th>Status</th><th style="text-align:right">+</th><th style="text-align:right">−</th></tr></thead>
          <tbody>
            ${fileRows}
            ${(files || []).length > 50 ? `<tr><td colspan="4" style="text-align:center;color:var(--muted)">…and ${(files || []).length - 50} more files</td></tr>` : ""}
          </tbody>
        </table>
      </section>` : ""}

      ${labels.length > 0 ? `
      <section class="card">
        <h2>Labels</h2>
        <p>${labelBadges}</p>
      </section>` : ""}

      <div class="footer">
        Generated by <code>scripts/generate-pr-design-docs.mjs</code>
        &nbsp;·&nbsp;
        <a href="https://github.com/${REPO}/pull/${pr.number}">View PR #${pr.number} on GitHub</a>
      </div>
    </main>
  </body>
</html>`;
}

// ---------------------------------------------------------------------------
// Markdown template
// ---------------------------------------------------------------------------

function mdDoc({ pr, files, commits }) {
  const title = pr.title || "Untitled PR";
  const description = extractDescription(pr.body);
  const mergedAt = pr.merged_at || (pr.merge_commit_sha ? pr.merged_at : null);
  const state = mergedAt ? "merged" : pr.state;
  const date = mergedAt || pr.created_at;
  const labels = extractLabels(pr);
  const diagram = archDiagram({ ...pr, files });
  const filesByPrefix = fileCountByPrefix(files || []);
  const totalAdditions = (files || []).reduce((s, f) => s + (f.additions || 0), 0);
  const totalDeletions = (files || []).reduce((s, f) => s + (f.deletions || 0), 0);

  const labelStr = labels.length > 0 ? labels.map((l) => `\`${l}\``).join(" ") : "none";

  return `# ${title}

## Overview

${description}

**PR:** [#${pr.number}](https://github.com/${REPO}/pull/${pr.number}) · **Status:** ${mdStateLabel(state, mergedAt)} · **Date:** ${formatDate(date)}

${labels.length > 0 ? `**Labels:** ${labelStr}\n` : ""}
**Author:** @${pr.user?.login || "unknown"}

---

## Architecture

<pre>
${diagram}
</pre>

---

## Metadata

| Metric | Value |
|--------|-------|
| Files changed | ${(files || []).length} |
| Commits | ${(commits || []).length} |
| Additions | +${totalAdditions} |
| Deletions | -${totalDeletions} |
| Head branch | \`${pr.head?.ref || ""}\` |
| Created | ${formatDate(pr.created_at)} |
${mergedAt ? `| Merged | ${formatDate(mergedAt)} |` : ""}

---

${Object.keys(filesByPrefix).length > 0 ? `## Files Changed (by package)

| Package / Path | Files |
|---|---|
${Object.entries(filesByPrefix).sort((a, b) => b[1] - a[1]).map(([p, c]) => `| \`${p}\` | ${c} |`).join("\n")}

---
` : ""}
${(files || []).length > 0 ? `## All Files Changed

| File | Status | + | − |
|---|---|---|---|
${(files || []).slice(0, 50).map((f) => `| \`${f.filename}\` | ${f.status} | +${f.additions ?? 0} | -${f.deletions ?? 0} |`).join("\n")}
${(files || []).length > 50 ? `\n_…and ${(files || []).length - 50} more files_\n` : ""}
---
` : ""}
Generated by \`scripts/generate-pr-design-docs.mjs\` · [View PR #${pr.number} on GitHub](https://github.com/${REPO}/pull/${pr.number})
`;
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function escHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Escape HTML injection vectors (&, <, >) while preserving markdown formatting.
 * Unlike escHtml, this does NOT escape * or backtick — those are markdown
 * syntax and must render for bold/code in the hero description.
 */
function escMd(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // --single-pr mode: generate only one PR's docs and exit
  if (SINGLE_PR !== null) {
    console.log(`\n🔍 Generating design doc for PR #${SINGLE_PR} …`);
    try {
      const outDir = join(ROOT, "docs", "design", "pr-designs");
      ensureDir(outDir);
      const mdPath = join(outDir, `pr-${SINGLE_PR}.md`);
      const htmlPath = join(outDir, `pr-${SINGLE_PR}.html`);

      // Idempotency: skip if both files already exist and --force not set
      // Short-circuit BEFORE any API calls to avoid burning quota on reruns.
      if (!FORCE && fileExists(mdPath) && fileExists(htmlPath)) {
        console.log(`   ⏭️  #${SINGLE_PR} — already exists, skipping`);
        console.log(`\n✅ Done — PR #${SINGLE_PR} already has design docs\n`);
        return;
      }

      // Fetch PR metadata directly — no list scanning needed
      const pr = await ghApi(`pulls/${SINGLE_PR}`, null);
      if (!pr || !pr.number) {
        console.error(`   ❌ PR #${SINGLE_PR} not found`);
        process.exit(1);
      }

      // Fetch files + commits in parallel
      const [files, commits] = await Promise.all([
        fetchPRFiles(SINGLE_PR),
        fetchPRCommits(SINGLE_PR),
      ]);

      const data = { pr: { ...pr, files, commits }, files, commits };

      if (!DRY_RUN) {
        writeFileSync(mdPath, mdDoc(data), "utf8");
        writeFileSync(htmlPath, htmlDoc(data), "utf8");
        console.log(`   ✅ Generated pr-${SINGLE_PR}.md and pr-${SINGLE_PR}.html`);
        console.log(`\n✅ Done — generated: 1\n`);
      } else {
        console.log(`   (dry-run, no files written)`);
        console.log(`\n✅ Dry run complete\n`);
      }
    } catch (err) {
      console.error(`   ❌ PR #${SINGLE_PR} error: ${err.message}`);
      process.exit(1);
    }
    return;
  }

  console.log(`\n🔍 Fetching PRs from ${REPO} …`);
  const allPRs = await fetchAllPRs();
  console.log(`   Found ${allPRs.length} total PRs`);

  const aoPRs = allPRs.filter(isAOManaged).slice(0, LIMIT);
  console.log(`   AO-managed PRs: ${aoPRs.length}\n`);

  const outDir = join(ROOT, "docs", "design", "pr-designs");
  ensureDir(outDir);

  let generated = 0;
  let skipped = 0;

  for (const pr of aoPRs) {
    const mdPath = join(outDir, `pr-${pr.number}.md`);
    const htmlPath = join(outDir, `pr-${pr.number}.html`);

    // Idempotency: skip if both exist and --force is not set
    const mdExists = fileExists(mdPath);
    const htmlExists = fileExists(htmlPath);
    if (!FORCE && mdExists && htmlExists) {
      skipped++;
      console.log(`   ⏭️  #${pr.number} — already exists, skipping`);
      continue;
    }

    console.log(`   📄 #${pr.number} [${pr.state}] ${pr.title.slice(0, 60)}`);

    if (DRY_RUN) continue;

    try {
      // Fetch files + commits in parallel
      const [files, commits] = await Promise.all([
        fetchPRFiles(pr.number),
        fetchPRCommits(pr.number),
      ]);

      const data = { pr: { ...pr, files, commits }, files, commits };

      writeFileSync(mdPath, mdDoc(data), "utf8");
      writeFileSync(htmlPath, htmlDoc(data), "utf8");
      generated++;
    } catch (err) {
      console.error(`   ❌ #${pr.number} error: ${err.message}`);
    }
  }

  console.log(`\n✅ Done — generated: ${generated}, skipped: ${skipped}\n`);
}

function fileExists(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
