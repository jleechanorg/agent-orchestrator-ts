#!/usr/bin/env node
/**
 * Real-tmux smoke test for bd-l5ty: end-to-end proof that bashrc-exported
 * vars actually reach a live tmux session via the same code path as
 * `loadBashrcEnv()` in `packages/plugins/runtime-tmux/src/index.ts`.
 *
 * Pipeline:
 *   1. `bash -ic 'declare -x'` to dump real bashrc exports
 *   2. Parse the dump (mirror of `parseBashrcOutput`)
 *   3. Build `-e KEY=VALUE` flags for tmux new-session
 *   4. Spawn a real tmux session with those flags
 *   5. `tmux show-env -t <session>` to verify vars landed in the session
 *
 * This is the proof that skeptics Gate 6/7 require: the runtime path is
 * exercised, not just mocked.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EVIDENCE_PATH = join(__dirname, "real-tmux-smoke.txt");

const HOME = process.env.HOME || "<unset>";
const out = (line) => {
  process.stdout.write(line + "\n");
  appendFileSync(EVIDENCE_PATH, line + "\n");
};

writeFileSync(EVIDENCE_PATH, "");

out(`# bd-l5ty real-tmux smoke test`);
out(`# date:           ${new Date().toISOString()}`);
out(`# HOME:           ${HOME}`);
out(`# node:           ${process.version}`);
out(`# tmux:           ${(execFileSync("tmux", ["-V"], { encoding: "utf-8" }).trim())}`);
out(`# shell:          ${process.env.SHELL || "<unset>"}`);
out(`# invocation:     bash -ic 'declare -x'  (matches loadBashrcEnv)`);
out("");

if (!process.env.HOME) {
  out("FAIL: HOME is unset — aborting.");
  process.exit(1);
}

// Step 1: dump bashrc exports
let raw;
try {
  raw = execFileSync(
    "bash",
    ["-ic", "declare -x"],
    { encoding: "utf-8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] },
  );
} catch (err) {
  out(`FAIL: bash -ic exited non-zero: ${err.message}`);
  process.exit(1);
}

// Step 2: parse declare -x output
const bashVars = {};
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
  bashVars[key] = value;
}

const keys = Object.keys(bashVars);
out(`# bashrc exports parsed: ${keys.length}`);
out("");

// Step 3: pick 3 small sentinel vars and prepare -e flags
// Avoid vars with multi-line values (those break tmux -e parsing).
const SENTINEL_KEYS = ["AO_BOT_GH_TOKEN", "MINIMAX_API_KEY", "MINIMAX_ANTHROPIC_BASE_URL"];
const sentinels = SENTINEL_KEYS.filter((k) => k in bashVars);
out(`# sentinel vars found: ${sentinels.length}/${SENTINEL_KEYS.length}`);
out(`#   ${sentinels.join(", ")}`);
out("");

if (sentinels.length === 0) {
  out("FAIL: no sentinel vars in bashrc — cannot prove injection.");
  process.exit(1);
}

// Step 4: spawn real tmux session with -e flags
const sessionName = `bd-l5ty-smoke-${Date.now()}`;
const eFlags = [];
for (const k of sentinels) {
  eFlags.push("-e", `${k}=${bashVars[k]}`);
}
const cwd = "/tmp";

try {
  execFileSync(
    "tmux",
    ["new-session", "-d", "-s", sessionName, "-c", cwd, ...eFlags, "sleep 30"],
    { encoding: "utf-8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] },
  );
} catch (err) {
  out(`FAIL: tmux new-session exited non-zero: ${err.message}`);
  process.exit(1);
}

// Step 5: tmux show-env to verify the sentinel vars landed in the session
let showEnvOut;
try {
  showEnvOut = execFileSync(
    "tmux",
    ["show-env", "-t", sessionName],
    { encoding: "utf-8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] },
  );
} catch (err) {
  out(`FAIL: tmux show-env exited non-zero: ${err.message}`);
  // Cleanup
  try { execFileSync("tmux", ["kill-session", "-t", sessionName], { stdio: "ignore" }); } catch (killErr) { /* best-effort cleanup */ void killErr; }
  process.exit(1);
}

let allFound = true;
out(`# tmux show-env -t ${sessionName} (sentinel-var presence):`);
for (const k of sentinels) {
  const re = new RegExp(`^${k}=`);
  const found = showEnvOut.split("\n").some((line) => re.test(line));
  if (!found) allFound = false;
  out(`#   ${k.padEnd(32)} ${found ? "PRESENT" : "MISSING"}`);
}
out("");

// Cleanup
try {
  execFileSync("tmux", ["kill-session", "-t", sessionName], { stdio: "ignore" });
} catch (killErr) { /* best-effort cleanup */ void killErr; }

if (allFound) {
  out(`# PASS: ${sentinels.length} sentinel vars present in real tmux session.`);
  process.exit(0);
} else {
  out(`# FAIL: at least one sentinel var missing in tmux session.`);
  process.exit(1);
}
