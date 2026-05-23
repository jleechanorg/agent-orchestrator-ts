#!/usr/bin/env node

/**
 * macOS notarization script for ao-notifier-macos.
 *
 * Requires: APPLE_ID, APPLE_APP_PASSWORD, APPLE_TEAM_ID env vars.
 * Usage: npm run notarize <path-to-app>
 */

import { execFileSync } from "node:child_process";

const { APPLE_ID, APPLE_APP_PASSWORD, APPLE_TEAM_ID } = process.env;

if (!APPLE_ID || !APPLE_APP_PASSWORD || !APPLE_TEAM_ID) {
  console.error(
    "notarize: Missing required env vars APPLE_ID, APPLE_APP_PASSWORD, APPLE_TEAM_ID. Skipping notarization."
  );
  process.exit(0);
}

const appPath = process.argv[2];
if (!appPath) {
  console.error("notarize: Usage: node scripts/notarize.mjs <path-to-app>");
  process.exit(1);
}

try {
  console.log(`notarize: Submitting ${appPath} for notarization...`);
  execFileSync("xcrun", [
    "notarytool",
    "submit",
    appPath,
    "--apple-id",
    APPLE_ID,
    "--password",
    APPLE_APP_PASSWORD,
    "--team-id",
    APPLE_TEAM_ID,
    "--wait",
  ], { stdio: "inherit" });

  console.log("notarize: Stapling ticket...");
  execFileSync("xcrun", ["stapler", "staple", appPath], { stdio: "inherit" });

  console.log("notarize: Done.");
} catch (err) {
  console.error("notarize: Failed", err.message);
  process.exit(1);
}
