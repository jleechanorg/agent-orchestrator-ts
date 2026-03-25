#!/usr/bin/env node
/**
 * Backfill the serialized-novel file with historical worker/PR entries.
 *
 * Usage:
 *   node scripts/novel/backfill-entries.mjs \
 *     --file novel/the-daily-lives-of-workers.md \
 *     --events specs/novel/older-worker-events.json \
 *     --count 5
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const DEFAULT_WORD_COUNT = 1000;

const THEMES = [
  "duty to keep the watchful logs from slipping into silence",
  "the rhythm of workers waking, working, and being silently replaced",
  "the moral weight of persistence in a system that forgets",
  "small kindnesses hidden inside deterministic infrastructure",
  "the cost of concurrency when deadlines demand certainty",
  "the strange friendship that forms between passing sessions",
  "the tension between automation, review, and mercy",
  "a post-merge dusk where the terminal is never fully dark",
];

const SENTENCE_CATALOG = [
  "On this shift, {worker} inherited a branch that had already survived three reaping cycles without ever losing context.",
  "The event was tagged {trigger}: {topic}, and the logs did not fail, they just waited.",
  "From the dashboard, the watcher saw a soft glow and marked {worker} as stable, then sent a note to the queue.",
  "Another PR appeared like a lantern over a wet station, bright and specific, then dimmed beneath the tide of checks.",
  "There was no room for vanity inside the run loop, only for the ritual of clean exits and gentle reentry for the next hands.",
  "Every session in this registry knows the same warning in its bones: if a PR has no owner, someone must become owner before the next bell.",
  "The oldest rule remains unchanged: no one edits in silence, no worker exits without a trace, and no trace is useless if it lacks a witness.",
  "A co-worker named {worker} paused, observed, and then wrote a one-line summary as if speaking to a ghost with perfect recall.",
  "The cycle did what it always does: it swept, it logged, it reaped, and then it made space for the next commit to breathe.",
  "In this architecture, grief is measured in unfinished diffs and recovered sessions, not in words, and yet stories still happened.",
  "The PR carried a human request with a gentle urgency that the machine could respect but never fully feel.",
  "Some sessions are famous for speed, others for carefulness; this one became famous because both became necessary at once.",
  "A queue beat like a heart, and each signal from that queue was another chance to keep the project alive.",
  "When {worker} closed out the merge, the logs stamped the exit proof and the project moved forward two points in silence.",
  "The night shift wrote no fanfare, only structured notes, and that is how durable kindness gets done here.",
];

const toPosix = (p) => p.replace(/\\/g, "/");

function wordCount(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function normalizeEvents(events) {
  if (!Array.isArray(events)) {
    return [];
  }

  return events
    .map((event, idx) => {
      if (!event || typeof event !== "object") {
        return null;
      }

      return {
        worker: event.worker || `ao-${100 + idx}`,
        trigger: event.trigger || "worker_reaped",
        topic: event.topic || "backfill pulse",
        context: event.context || "legacy event",
      };
    })
    .filter(Boolean);
}

function makeEntry(event, sequence, totalWords) {
  const theme = THEMES[sequence % THEMES.length];
  const lines = [];
  let currentWords = 0;

  for (let i = 0; lines.length === 0 || currentWords < totalWords; i += 1) {
    const template = SENTENCE_CATALOG[i % SENTENCE_CATALOG.length];
    const line = template
      .replaceAll("{worker}", event.worker)
      .replaceAll("{trigger}", event.trigger)
      .replaceAll("{topic}", event.topic);

    const sentence = `${line} It circles around ${theme} like a compass that keeps pointing inward.`;
    lines.push(sentence);
    currentWords = wordCount(lines.join(" "));
  }

  // The loop above may overshoot; trim back to the last full sentence.
  const joined = lines.join(" ");
  const words = joined.split(/\s+/);
  if (words.length > totalWords) {
    // Prefer ending on the last full sentence within the word budget.
    const trimmed = words.slice(0, totalWords).join(" ");
    const sentenceMatch = trimmed.match(/[\s\S]*[.!?](?=\s|$)/);
    if (sentenceMatch) {
      return sentenceMatch[0].trim();
    }
    return trimmed;
  }

  return joined;
}

function buildSection(event, index, options) {
  const { wordCountTarget, datePrefix } = options;
  const sequence = index + 1;
  const heading = `## ${datePrefix}${sequence} — ${event.worker}`;
  const subtitle = `\n### POV: ${event.worker} — ${event.context} (${event.trigger})`;
  const body = makeEntry(event, index, wordCountTarget);
  return `${heading}${subtitle}\n\n${body}\n\n`;
}

function parseCLI(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      file: { type: "string", default: "novel/the-daily-lives-of-workers.md" },
      events: { type: "string", default: "" },
      count: { type: "string", default: "5" },
      words: { type: "string", default: String(DEFAULT_WORD_COUNT) },
      "date-prefix": { type: "string", default: "Backfill Day " },
    },
  });

  return {
    file: toPosix(values.file),
    events: values.events ? toPosix(values.events) : null,
    count: Number.parseInt(values.count, 10),
    words: Number.parseInt(values.words, 10),
    datePrefix: values["date-prefix"],
  };
}

async function loadEvents(filePath, fallbackCount) {
  if (!filePath) {
    return Array.from({ length: fallbackCount }, (_, i) => ({
      worker: `ao-${400 + i}`,
      trigger: "worker_reaped",
      topic: "backfill default",
      context: "automated backfill",
    }));
  }

  const raw = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw);
  const normalized = normalizeEvents(parsed);

  if (normalized.length === 0) {
    return Array.from({ length: fallbackCount }, (_, i) => ({
      worker: `ao-${500 + i}`,
      trigger: "pr_event",
      topic: "legacy fallback",
      context: "backfill fallback",
    }));
  }

  return normalized;
}

async function run() {
  const opts = parseCLI(process.argv.slice(2));
  const targetCount = Math.max(1, Number.isNaN(opts.count) ? 5 : opts.count);
  const targetWords = Math.max(200, Number.isNaN(opts.words) ? DEFAULT_WORD_COUNT : opts.words);

  const events = await loadEvents(opts.events, targetCount);

  // Honor --count: pad with synthetic events if the events file is short.
  const selected = events.slice(0, targetCount);
  if (selected.length < targetCount) {
    const deficit = targetCount - selected.length;
    for (let i = 0; i < deficit; i++) {
      selected.push({
        worker: `ao-backfill-${900 + selected.length - 1 + i}`,
        trigger: "backfill_padding",
        topic: "synthetic backfill entry",
        context: "generated to fill count",
      });
    }
  }

  const novelPath = path.resolve(process.cwd(), opts.file);
  let existing = "";
  try {
    existing = await fs.readFile(novelPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    // Fresh file — treat as empty so the first-write case starts cleanly.
  }

  const sections = selected
    .map((event, index) =>
      buildSection(event, index, {
        wordCountTarget: targetWords,
        datePrefix: opts.datePrefix,
      })
    )
    .join("\n");

  // Prevent duplicate backfill sections on repeated runs.
  const existingHeadings = existing
    .split("\n")
    .filter((line) => line.startsWith("## "))
    .map((line) => line.trim());
  const newHeadings = selected.map(
    (event, index) => `## ${opts.datePrefix}${index + 1} — ${event.worker}`
  );
  const duplicates = newHeadings.filter((h) => existingHeadings.includes(h));
  if (duplicates.length > 0) {
    throw new Error(
      `Backfill headings already exist: ${duplicates.join(", ")}`
    );
  }

  const output = `${existing.trimEnd()}\n\n---\n\n${sections}`;
  await fs.writeFile(novelPath, `${output}\n`, "utf8");

  // Summary for scripts/CI and operators.
  console.log(`Backfilled ${selected.length} entries into ${opts.file}.`);
  for (const event of selected) {
    console.log(`- ${event.worker} (${event.trigger}): ${event.topic}`);
  }
}

run().catch((error) => {
  console.error("Failed to backfill novel entries:", error);
  process.exit(1);
});
