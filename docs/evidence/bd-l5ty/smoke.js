#!/usr/bin/env node
/**
 * Real-bashrc smoke test for bd-l5ty: source the actual user `~/.bashrc` via
 * `bash -ic 'declare -x'` and print a sanitized summary (count + the bead's
 * named target vars only — never the full key list, which would expose
 * sensitive infrastructure metadata). Proves the helper's invocation pattern
 * works against the real bashrc, not just the mocked test output.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EVIDENCE_PATH = join(__dirname, "real-bashrc-smoke.txt");

const HOME = process.env.HOME || "<unset>";
const out = (line) => {
  process.stdout.write(line + "\n");
  appendFileSync(EVIDENCE_PATH, line + "\n");
};

// Truncate the output file first.
writeFileSync(EVIDENCE_PATH, "");

out(`# bd-l5ty real-bashrc smoke test`);
out(`# date:           ${new Date().toISOString()}`);
out(`# HOME:           ${HOME}`);
out(`# node:           ${process.version}`);
out(`# shell:          ${process.env.SHELL || "<unset>"}`);
out(`# invocation:     bash -ic 'declare -x'  (matches loadBashrcEnv in runtime-tmux/src/index.ts)`);
out("");

if (!process.env.HOME) {
  out("FAIL: HOME is unset — loadBashrcEnv() would return {} (non-fatal).");
  process.exit(1);
}

let raw;
try {
  raw = execFileSync(
    "bash",
    ["-ic", "declare -x"],
    {
      encoding: "utf-8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
} catch (err) {
  out(`FAIL: bash -ic exited non-zero: ${err.message}`);
  out("loadBashrcEnv() would catch this and return {} (non-fatal).");
  process.exit(1);
}

out(`# raw output size: ${raw.length} bytes`);
out("");

const vars = {};
for (const line of raw.split("\n")) {
  const m = line.match(/^declare -x ([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (!m) continue;
  const key = m[1];
  let value = m[2].replace(/\s+$/, "");
  if (value.length >= 2) {
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
  }
  if (value.length === 0) continue;
  vars[key] = value;
}

const keys = Object.keys(vars).sort();
out(`# total exported vars parsed: ${keys.length}`);
out(`# (cap applied at MAX_BASHRC_VARS=10000; see runtime-tmux/src/index.ts)`);
out("");

// Aggregated prefix counts only — do NOT enumerate individual keys (the full
// list leaks infrastructure metadata even without values).
const byPrefix = new Map();
for (const k of keys) {
  const prefix = k.includes("_") ? k.split("_")[0] + "_" : "(no-underscore)";
  byPrefix.set(prefix, (byPrefix.get(prefix) || 0) + 1);
}
out(`# aggregated key count by prefix (values never printed):`);
for (const [prefix, count] of [...byPrefix.entries()].sort()) {
  out(`#   ${prefix.padEnd(24)} ${count.toString().padStart(3)} keys`);
}
out("");

// Highlight the bead's named target vars. The 4th target is the real-world
// token name itself — we report its presence via the explicit pass/fail
// check below rather than printing the literal name in this committed file.
const NAMED_TARGETS = ["AO_BOT_GH_TOKEN", "MINIMAX_API_KEY", "MINIMAX_ANTHROPIC_BASE_URL"];
out(`# status of bead-mentioned bashrc exports:`);
for (const t of NAMED_TARGETS) {
  out(`#   ${t.padEnd(32)} ${t in vars ? "FOUND" : "missing"}`);
}
out(`#   ${"<GH_TOKEN-style var>".padEnd(32)} ${keys.some((k) => /^GH_TOKEN_/.test(k)) ? "FOUND" : "missing"}`);
out("");

out(`# PASS: bashrc sourced ${keys.length} vars; loadBashrcEnv() would inject them.`);
process.exit(0);
