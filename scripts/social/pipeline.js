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

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
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
const chapterArg = args.find(a => a.startsWith('--chapter='));
const chapterFilter = chapterArg ? chapterArg.split('=')[1] : null;

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
    if (chapterFilter && !heading.toLowerCase().includes(chapterFilter.toLowerCase())) {
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
  console.log(`🎬  Rendering video for: "${chapter.heading}"`);

  const videoDir = join(REPO_ROOT, 'novel/upstream/video');
  if (!existsSync(join(videoDir, 'package.json'))) {
    console.log('📦  Installing Remotion dependencies...');
    execSync('npm install', { cwd: videoDir, stdio: 'inherit' });
  }

  // Write chapter data to a temp JSON file that Remotion will read
  const chapterDataPath = join(videoDir, 'src/chapter-data.json');
  writeFileSync(chapterDataPath, JSON.stringify(chapter, null, 2));

  // Render the daily-chapter composition (create this in Remotion project)
  const outFile = `ao-novel-${Date.now()}.mp4`;
  mkdirSync(join(videoDir, 'out'), { recursive: true });

  try {
    execSync(
      `npx remotion render src/index.ts DailyChapter out/${outFile} --log=verbose --overwrite`,
      { cwd: videoDir, stdio: 'inherit' }
    );
  } catch {
    // If DailyChapter composition doesn't exist yet, fall back to TheAwakening
    console.warn('⚠️  DailyChapter composition not found — using TheAwakening fallback');
    execSync(
      `npx remotion render src/index.ts TheAwakening out/${outFile} --log=verbose --overwrite`,
      { cwd: videoDir, stdio: 'inherit' }
    );
  }

  const videoPath = join(videoDir, 'out', outFile);
  if (!existsSync(videoPath)) {
    throw new Error(`Render failed — output not found at ${videoPath}`);
  }

  const stats = existsSync(videoPath) ? readFileSync(videoPath).length : 0;
  console.log(`✅  Video rendered: ${outFile} (${Math.round(stats / 1024 / 1024)}MB)`);
  return videoPath;
}

// ─── Step 3: YouTube upload ──────────────────────────────────────────────────

async function uploadToYouTube(videoPath, chapter) {
  const credPath = join(CRED_DIR, 'youtube-credentials.json');
  if (!existsSync(credPath)) {
    console.warn('⚠️  YouTube credentials not found. Skipping YouTube upload.');
    console.warn(`   Place OAuth credentials at: ${credPath}`);
    console.warn('   See: docs/SOCIAL_PIPELINE.md for setup instructions.');
    return null;
  }

  console.log('📤  Uploading to YouTube Shorts...');

  const { google } = await import('googleapis');
  const credentials = JSON.parse(readFileSync(credPath, 'utf-8'));

  const oauth2Client = new google.auth.OAuth2(
    credentials.client_id,
    credentials.client_secret,
    credentials.redirect_uris[0]
  );

  // Check for cached token
  const tokenPath = join(CRED_DIR, 'youtube-token.json');
  if (existsSync(tokenPath)) {
    oauth2Client.setCredentials(JSON.parse(readFileSync(tokenPath, 'utf-8')));
  } else {
    console.log('🔑  YouTube OAuth — open browser to authorize...');
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
    console.log('✅  YouTube token cached.');
  }

  const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

  // Get video duration via ffprobe
  try {
    execSync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`,
      { encoding: 'utf-8', stdio: 'pipe' }
    );
  } catch {
    // ffprobe unavailable — continue without duration metadata
  }

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
  console.log(`✅  YouTube Shorts uploaded! https://youtube.com/shorts/${videoId}`);
  return videoId;
}

// ─── Step 4: TikTok upload ───────────────────────────────────────────────────

async function uploadToTikTok(videoPath, chapter) {
  const sessionPath = join(CRED_DIR, 'tiktok-session.json');
  if (!existsSync(sessionPath)) {
    console.warn('⚠️  TikTok session cookies not found. Skipping TikTok upload.');
    console.warn(`   Place session cookies at: ${sessionPath}`);
    console.warn('   See: docs/SOCIAL_PIPELINE.md for setup instructions.');
    return null;
  }

  console.log('📤  Uploading to TikTok...');

  const session = JSON.parse(readFileSync(sessionPath, 'utf-8'));

  // TikTok upload via Puppeteer browser automation (session cookies)
  // TikTok requires browser-based upload flow — no simple REST alternative
  const _formData = (await import('form-data')).default;
  const _fetch = (await import('node-fetch')).default;

  // Step 1: Probe upload endpoint (informational)
  await _fetch('https://www.tiktok.com/api/upload/instances/', {
    headers: { 'User-Agent': 'Mozilla/5.0' }
  }).catch(() => {});

  // TikTok requires browser-based upload flow. Use Puppeteer if available.
  try {
    const { default: puppeteer } = await import('puppeteer');
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();

    // Set session cookies
    for (const cookie of session.cookies) {
      await page.setCookie(cookie);
    }

    await page.goto('https://www.tiktok.com/upload', { waitUntil: 'networkidle2' });
    await page.waitForTimeout(3000);

    // Upload video via file input
    const fileInput = await page.$('input[type="file"]');
    if (fileInput) {
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
      const postBtn = await page.$('button:has-text("Post")');
      if (postBtn) {
        await postBtn.click();
        await page.waitForTimeout(3000);
      }
    }

    await browser.close();
    console.log('✅  TikTok upload initiated via browser automation.');
    return 'uploaded';
  } catch (err) {
    if (err.code === 'ERR_MODULE_NOT_FOUND') {
      console.warn('⚠️  Puppeteer not installed. TikTok upload requires: npm install puppeteer');
    } else {
      console.warn(`⚠️  TikTok upload failed: ${err.message}`);
    }
    return null;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🚀  AO Novel Social Pipeline — starting...\n');

  // Step 1: Extract chapter
  console.log('📖  Extracting latest chapter...');
  const chapter = extractLatestChapter(NOVEL_FILE);
  console.log(`   "${chapter.heading}" (${chapter.wordCount} words)`);

  // Step 2: Render video
  console.log('');
  const videoPath = renderVideo(chapter);

  if (renderOnly) {
    console.log('\n✅  Render-only mode — skipping uploads.');
    return;
  }

  // Step 3: Upload to YouTube
  console.log('');
  let youtubeId = null;
  try {
    youtubeId = await uploadToYouTube(videoPath, chapter);
  } catch (err) {
    console.error(`❌  YouTube upload failed: ${err.message}`);
  }

  // Step 4: Upload to TikTok
  console.log('');
  let tiktokId = null;
  try {
    tiktokId = await uploadToTikTok(videoPath, chapter);
  } catch (err) {
    console.error(`❌  TikTok upload failed: ${err.message}`);
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

  console.log('\n🏁  Pipeline complete.');
  if (youtubeId) console.log(`   YouTube: https://youtube.com/shorts/${youtubeId}`);
  if (tiktokId) console.log(`   TikTok: uploaded`);
  if (!youtubeId && !tiktokId) console.log('   (no uploads completed — set credentials first)');
}

main().catch(err => {
  console.error(`\n❌  Pipeline failed: ${err.message}`);
  process.exit(1);
});
