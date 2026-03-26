#!/usr/bin/env node
/**
 * AO Novel Social Pipeline
 *
 * Orchestrates the daily render → upload cycle:
 *   1. Pull latest chapter from novel/the-daily-lives-of-workers.md
 *   2. Render a Remotion short video from the chapter
 *   3. Upload to YouTube Shorts
 *   4. Upload to TikTok
 *
 * Env vars required:
 *   GOOGLE_APPLICATION_CREDENTIALS   — path to YouTube OAuth credentials JSON
 *   YOUTUBE_CHANNEL_ID              — target YouTube channel ID
 *   TIKTOK_SESSION_COOKIES         — TikTok session cookies (Cookiejar format)
 *
 * Usage:
 *   node pipeline.js                        # full pipeline
 *   node pipeline.js --render-only          # render only, skip uploads
 *   node pipeline.js --chapter "Chapter 42"   # render specific chapter
 */

import { readFileSync, statSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '../..');
const NOVEL_FILE = join(REPO_ROOT, 'novel/the-daily-lives-of-workers.md');
const CRED_DIR = join(__dirname, 'credentials');

// ─── Argument parsing ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const renderOnly = args.includes('--render-only');

// Support both --chapter=VALUE and --chapter VALUE forms
let chapterFilter = null;
const chapterIdx = args.indexOf('--chapter');
if (chapterIdx !== -1 && args[chapterIdx + 1] !== undefined) {
  chapterFilter = args[chapterIdx + 1];
} else {
  const chapterArg = args.find(a => a.startsWith('--chapter='));
  if (chapterArg) {
    chapterFilter = chapterArg.split('=')[1];
  }
}

// ─── Step 1: Extract latest chapter ─────────────────────────────────────────

function extractLatestChapter(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`Novel file not found: ${filePath}`);
  }

  const content = readFileSync(filePath, 'utf-8');
  const sections = content.split(/^## /m);

  // Find the most recent chapter (last "## " heading that's a chapter)
  for (let i = sections.length - 1; i >= 1; i--) {
    const section = sections[i];
    const lines = section.split('\n');
    const heading = lines[0].trim();

    // Skip non-chapter headings like "Prologue", "Epilogue", "Summary"
    if (chapterFilter && heading !== chapterFilter) {
      // Exact comparison prevents "Chapter 1" matching "Chapter 10"
      continue;
    }
    if (/^(Prologue|Epilogue|Summary|Key Findings)/i.test(heading)) {
      continue;
    }

    // Extract the first ~400 words for a 30-60s short
    const body = lines.slice(1).join('\n').trim();
    const words = body.split(/\s+/);
    const excerpt = words.slice(0, 400).join(' ');

    return {
      heading,
      excerpt,
      wordCount: words.length,
      fullBody: body,
    };
  }

  throw new Error('No chapter found in novel file');
}

// ─── Step 2: Render video via Remotion ───────────────────────────────────────

function renderVideo(chapter) {
  console.log(`\uD83C\uDFAC  Rendering video for: "${chapter.heading}"`);

  const videoDir = join(REPO_ROOT, 'novel/upstream/video');

  if (!existsSync(join(videoDir, 'package.json'))) {
    throw new Error(
      `Remotion project not found at ${videoDir}/package.json — cannot render. ` +
      'Ensure novel/upstream/video/ exists in the repo.'
    );
  }

  if (!existsSync(join(videoDir, 'node_modules'))) {
    console.log('\uD83D\uDCE6  Installing Remotion dependencies...');
    execSync('npm install', { cwd: videoDir, stdio: 'inherit' });
  }

  // Write chapter data to a temp JSON file that Remotion will read
  const chapterDataPath = join(videoDir, 'src/chapter-data.json');
  writeFileSync(chapterDataPath, JSON.stringify(chapter, null, 2));

  // Render the DailyChapter composition with chapter data
  const outFile = `ao-novel-${Date.now()}.mp4`;
  mkdirSync(join(videoDir, 'out'), { recursive: true });

  try {
    execSync(
      `npx remotion render src/index.ts DailyChapter out/${outFile} --props "${chapterDataPath}" --log=verbose --overwrite`,
      { cwd: videoDir, stdio: 'inherit' }
    );
  } catch (err) {
    // Only fallback for missing composition — surface other errors
    const isMissingComp =
      err.message?.includes('composition not found') ||
      (err.stderr && err.stderr.includes('composition not found')) ||
      (err.message && /DailyChapter/i.test(err.message));
    if (isMissingComp) {
      console.warn('\u26A0\uFE0F  DailyChapter composition not found — using TheAwakening fallback');
      execSync(
        `npx remotion render src/index.ts TheAwakening out/${outFile} --log=verbose --overwrite`,
        { cwd: videoDir, stdio: 'inherit' }
      );
    } else {
      console.error(`\u274C  Render failed: ${err.message ?? err}`);
      throw err;
    }
  }

  const videoPath = join(videoDir, 'out', outFile);
  if (!existsSync(videoPath)) {
    throw new Error(`Render failed — output not found at ${videoPath}`);
  }

  const { size } = statSync(videoPath);
  console.log(`\u2705  Video rendered: ${outFile} (${Math.round(size / 1024 / 1024)}MB)`);
  return videoPath;
}

// ─── Step 3: YouTube upload ──────────────────────────────────────────────────

async function uploadToYouTube(videoPath, chapter) {
  const credPath = join(CRED_DIR, 'youtube-credentials.json');
  if (!existsSync(credPath)) {
    console.warn('\u26A0\uFE0F  YouTube credentials not found. Skipping YouTube upload.');
    console.warn(`   Place OAuth credentials at: ${credPath}`);
    console.warn('   See: docs/SOCIAL_PIPELINE.md for setup instructions.');
    return null;
  }

  console.log('\uD83D\uDCE4  Uploading to YouTube Shorts...');

  const { google } = await import('googleapis');
  const parsed = JSON.parse(readFileSync(credPath, 'utf-8'));
  // Normalize: Google wraps credentials under "installed" or "web" key
  const credentials = parsed.installed ?? parsed.web ?? parsed;

  const oauth2Client = new google.auth.OAuth2(
    credentials.client_id,
    credentials.client_secret,
    credentials.redirect_uris?.[0] ?? 'http://localhost'
  );

  // Check for cached token
  const tokenPath = join(CRED_DIR, 'youtube-token.json');
  if (existsSync(tokenPath)) {
    oauth2Client.setCredentials(JSON.parse(readFileSync(tokenPath, 'utf-8')));
  } else {
    console.log('\uD83D\uDD11  YouTube OAuth — open browser to authorize...');
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: ['https://www.googleapis.com/auth/youtube.upload'],
    });
    console.log(`   ${authUrl}`);
    console.log('   Paste authorization code: ');

    const readline = await import('readline');
    const rl = readline.default.createInterface({ input: process.stdin, output: process.stdout });
    const code = await new Promise(resolve => rl.question('', resolve));
    rl.close();

    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    writeFileSync(tokenPath, JSON.stringify(tokens));
    console.log('\u2705  YouTube token cached.');
  }

  const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

  const response = await youtube.videos.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: {
        title: `${chapter.heading} — The Daily Lives of Workers`,
        description: `${chapter.excerpt}\n\nSubscribe for daily dispatches from the workers of Agent Orchestrator.\n\n#aicoders #softwareengineering #automation`,
        tags: ['AI coding agents', 'software engineering', 'automation', 'agent orchestrator'],
        categoryId: '28', // Science & Technology
      },
      status: {
        privacyStatus: 'public',
        selfDeclaredMadeForKids: false,
      },
    },
    media: {
      body: readFileSync(videoPath),
    },
  });

  const videoId = response.data.id;
  console.log(`\u2705  YouTube Shorts uploaded! https://youtube.com/shorts/${videoId}`);
  return videoId;
}

// ─── Step 4: TikTok upload ───────────────────────────────────────────────────

async function uploadToTikTok(videoPath, chapter) {
  const sessionPath = join(CRED_DIR, 'tiktok-session.json');
  if (!existsSync(sessionPath)) {
    console.warn('\u26A0\uFE0F  TikTok session cookies not found. Skipping TikTok upload.');
    console.warn(`   Place session cookies at: ${sessionPath}`);
    console.warn('   See: docs/SOCIAL_PIPELINE.md for setup instructions.');
    return null;
  }

  console.log('\uD83D\uDCE4  Uploading to TikTok...');

  const session = JSON.parse(readFileSync(sessionPath, 'utf-8'));

  // TikTok requires browser-based upload flow. Use Puppeteer if available.
  let browser = null;
  try {
    const { default: puppeteer } = await import('puppeteer');
    browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();

    // Set session cookies
    for (const cookie of session.cookies) {
      await page.setCookie(cookie);
    }

    await page.goto('https://www.tiktok.com/upload', { waitUntil: 'networkidle2' });
    await page.waitForTimeout(3000);

    // Upload video via file input
    const fileInput = await page.$('input[type="file"]');
    if (!fileInput) {
      console.warn('\u26A0\uFE0F  TikTok upload: file input not found on page.');
      return null;
    }

    await fileInput.uploadFile(videoPath);
    await page.waitForTimeout(5000); // Wait for upload + processing

    // Fill in caption
    const caption = `${chapter.heading} — The Daily Lives of Workers\n\n${chapter.excerpt.slice(0, 150)}...\n\n#AI #codingagents #automation`;
    const captionField = await page.$('div[contenteditable="true"]');
    if (captionField) {
      await captionField.click();
      await page.keyboard.type(caption);
    }

    // Click post button
    const postBtn = await page.$('button');
    const postBtnText = postBtn ? await postBtn.evaluate(el => el.textContent) : '';
    if (postBtn && /post/i.test(postBtnText)) {
      await postBtn.click();
      await page.waitForTimeout(3000);
    } else {
      console.warn('\u26A0\uFE0F  TikTok upload: post button not found.');
      return null;
    }

    console.log('\u2705  TikTok upload initiated via browser automation.');
    return 'uploaded';
  } catch (err) {
    if (err.code === 'ERR_MODULE_NOT_FOUND') {
      console.warn('\u26A0\uFE0F  Puppeteer not installed. TikTok upload requires: npm install puppeteer');
    } else {
      console.warn(`\u26A0\uFE0F  TikTok upload failed: ${err.message}`);
    }
    return null;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\uD83D\uDE80  AO Novel Social Pipeline — starting...\n');

  // Step 1: Extract chapter
  console.log('\uD83D\uDCD6  Extracting latest chapter...');
  const chapter = extractLatestChapter(NOVEL_FILE);
  console.log(`   "${chapter.heading}" (${chapter.wordCount} words)`);

  // Step 2: Render video
  console.log('');
  const videoPath = renderVideo(chapter);

  if (renderOnly) {
    console.log('\n\u2705  Render-only mode — skipping uploads.');
    return;
  }

  // Step 3: Upload to YouTube
  console.log('');
  let youtubeId = null;
  try {
    youtubeId = await uploadToYouTube(videoPath, chapter);
  } catch (err) {
    console.error(`\u274C  YouTube upload failed: ${err.message}`);
  }

  // Step 4: Upload to TikTok
  console.log('');
  let tiktokId = null;
  try {
    tiktokId = await uploadToTikTok(videoPath, chapter);
  } catch (err) {
    console.error(`\u274C  TikTok upload failed: ${err.message}`);
  }

  // Log result
  const logEntry = {
    date: new Date().toISOString(),
    chapter: chapter.heading,
    videoPath,
    youtubeId,
    tiktokId,
  };

  const logFile = join(__dirname, 'upload-log.jsonl');
  writeFileSync(logFile, JSON.stringify(logEntry) + '\n', { flag: 'a' });

  console.log('\n\uD83C\uDFC1  Pipeline complete.');
  if (youtubeId) console.log(`   YouTube: https://youtube.com/shorts/${youtubeId}`);
  if (tiktokId) console.log('   TikTok: uploaded');
  if (!youtubeId && !tiktokId) console.log('   (no uploads completed — set credentials first)');
}

main().catch(err => {
  console.error(`\n\u274C  Pipeline failed: ${err.message}`);
  process.exit(1);
});
