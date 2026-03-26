# AO Novel — Social Media Automation Pipeline

Automated daily pipeline: AO worker activity → serialized chapter → animated short → YouTube Shorts + TikTok.

## Architecture

```text
PR merged / worker reaped
         ↓
  ai.agento.novel-daily (launchd, 6am PT)
         ↓
  pnpm novel:daily → appends chapter to novel/the-daily-lives-of-workers.md
         ↓
  node pipeline.js (cron or launchd)
         ├→ Remotion renders DailyChapter composition
         ├→ YouTube Shorts upload (OAuth2)
         └→ TikTok upload (browser automation)
```

## Setup

### 1. Clone + install

```bash
# The Remotion project lives in the agent-orchestrator repo:
cd ~/projects/orch_jleechanclaw/novel/upstream/video
npm install

# Install social pipeline deps:
cd ~/projects/orch_jleechanclaw/scripts/social
npm install

# Optional: Puppeteer for TikTok browser automation
npm install puppeteer
```

### 2. YouTube OAuth Setup

**Steps:**

1. Go to [console.cloud.google.com](https://console.cloud.google.com) → create project (or use existing)
2. Enable **YouTube Data API v3** under "APIs & Services"
3. Go to "Credentials" → "Create Credentials" → "OAuth client ID"
   - Application type: **Desktop app** (or Web if you have a domain)
   - Download the JSON
4. Save as `scripts/social/credentials/youtube-credentials.json`

**Credential format:**
```json
{
  "installed": {
    "client_id": "...",
    "client_secret": "...",
    "redirect_uris": ["http://localhost"],
    "auth_uri": "https://accounts.google.com/o/oauth2/auth",
    "token_uri": "https://oauth2.googleapis.com/token"
  }
}
```

5. **First run**: On first upload, the script will print an auth URL. Open it in your browser, authorize, copy the code back into the terminal.
6. Token is cached at `scripts/social/credentials/youtube-token.json` — keep it safe.

**YouTube channel setup:**
- Create a dedicated YouTube channel for the content
- Set `YOUTUBE_CHANNEL_ID` in env (or the script will upload to your default channel)
- For YouTube Shorts: video must be ≤60s, 9:16 portrait (1080x1920) or square

### 3. TikTok Setup

**Option A — Browser automation (recommended for MVP):**
```bash
npm install puppeteer
```

TikTok requires you to be logged in. Export your session cookies:

1. Open TikTok in Chrome DevTools → Application → Cookies
2. Export as JSON with this format:
```json
{
  "cookies": [
    { "name": "sessionid", "value": "...", "domain": ".tiktok.com", "path": "/" },
    { "name": "sessionid_ss", "value": "...", "domain": ".tiktok.com", "path": "/" }
  ]
}
```
3. Save as `scripts/social/credentials/tiktok-session.json`

**Option B — TikTok Creator API (production, requires application):**
- Apply at [developers.tiktok.com](https://developers.tiktok.com)
- Use the Posting API for programmatic uploads
- More reliable than cookie-based, but requires TikTok approval

### 4. Verify Remotion renders

```bash
cd ~/projects/orch_jleechanclaw/novel/upstream/video
bash render.sh
# or render a specific composition:
bash render.sh TheAwakening
```

Expected output: `out/the-awakening.mp4` (or similar)

## Daily Usage

### Full pipeline (render + both uploads)
```bash
cd ~/projects/orch_jleechanclaw/scripts/social
node pipeline.js
```

### Render only (no uploads)
```bash
node pipeline.js --render-only
```

### Render specific chapter
```bash
node pipeline.js --chapter "Chapter 5"
```

## Automated Scheduling

Add to your launchd or cron to run after `ai.agento.novel-daily`:

### launchd (macOS)

Create `~/Library/LaunchAgents/ai.agento.social-pipeline.plist`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.agento.social-pipeline</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/jleechan/projects/orch_jleechanclaw/scripts/social/pipeline.js</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>7</integer>
    <key>Minute</key><integer>0</integer>
  </dict>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>/tmp/ao-social-pipeline.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/ao-social-pipeline.err</string>
</dict>
</plist>
```

Then:
```bash
ln -sf ~/projects/orch_jleechanclaw/docs/ai.agento.social-pipeline.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/ai.agento.social-pipeline.plist
```

## Video Specs

| Platform | Max Duration | Aspect Ratio | Resolution |
|----------|-------------|--------------|------------|
| YouTube Shorts | 60s | 9:16 or 1:1 | 1080x1920 or 1080x1080 |
| TikTok | 10 min | 9:16 | 1080x1920 |

Remotion's `DailyChapter` composition renders at 1080x1920 portrait by default — ideal for Shorts and TikTok.

## Troubleshooting

### "DailyChapter composition not found"
The pipeline falls back to `TheAwakening` when DailyChapter is not registered. The PR already adds DailyChapter to `src/Root.tsx`. To ensure it's active:

1. `src/DailyChapter.tsx` is already in the Remotion project (added by this PR)
2. It is registered in `src/Root.tsx` via `<Composition id="DailyChapter" ...>` (added by this PR)
3. Rebuild: `cd novel/upstream/video && npm run build`

### "YouTube token expired"
Delete `scripts/social/credentials/youtube-token.json` and re-run — it will prompt for fresh auth.

### "TikTok upload blocked"
TikTok aggressively blocks automated uploads. Options:
- Use a fresh session cookie (logged in, not 2FA'd)
- Rotate user agents
- Use TikTok Creator API (Option B) for production

## Credential Security

Credentials directory is gitignored. Never commit `credentials/youtube-credentials.json` or `credentials/tiktok-session.json`.
