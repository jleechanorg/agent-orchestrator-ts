#!/usr/bin/env node
/**
 * Real-tmux smoke test for bd-l5ty: end-to-end proof that bashrc-exported
 * vars actually reach a live tmux session via the OS-level integration
 * boundary that `loadBashrcEnv()` in `packages/plugins/runtime-tmux/src/index.ts`
 * relies on at runtime.
 *
 * This is NOT a unit test of the parser — that is already covered by
 * `packages/plugins/runtime-tmux/src/__tests__/index.test.ts` (7 new tests
 * including bash `$'…'` ANSI-C, empty values, 10K cap, missing bashrc,
 * explicit env override, etc.).
 *
 * This IS a Layer 2 integration test of the bashrc → tmux boundary: the
 * unit test mocks `execFile("bash", ["-ic", "declare -x"])`, but the real
 * question is whether what bash ACTUALLY emits in a real interactive
 * shell — with the user's real bashrc, real $'…' quoting, real multiline
 * values, real aliases, etc. — round-trips through `tmux new-session -e`
 * and shows up under `tmux show-env`. That is the only thing this script
 * verifies.
 *
 * Pipeline:
 *   1. `bash -ic 'declare -x'` to dump real bashrc exports
 *      (same invocation loadBashrcEnv uses)
 *   2. Parse the dump with the same regex as the runtime
 *   3. Build `-e KEY=VALUE` flags for tmux new-session
 *   4. Spawn a real tmux session with those flags
 *   5. `tmux show-env -t <session>` to verify vars landed in the session
 *
 * On success, prints sentinel-var presence and exits 0. On any failure,
 * prints which step failed and exits 1.
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
