# Pinterest Video Downloader — Self-Hosted

A fully self-hosted Pinterest video downloader with multi-quality support (360p, 480p, 720p, 1080p).

## Requirements
- Node.js v18 or higher
- npm

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Start the server
npm start

# 3. Open in browser
# http://localhost:3000
```

For development with auto-reload:
```bash
npm run dev
```

## How It Works

1. User pastes a Pinterest URL (supports pin.it short links too)
2. Server resolves the URL, fetches the Pinterest page with browser-like headers
3. Parses the embedded JSON data (`__PWS_INITIAL_STRING__` or `__NEXT_DATA__`)
4. Extracts all available video qualities (360p → 1080p)
5. Frontend shows all download options — clicking any downloads via the `/api/download` proxy

## Deploy to Production

### Railway (easiest)
1. Push this folder to a GitHub repo
2. Go to railway.app → New Project → Deploy from GitHub
3. Done — Railway auto-detects Node.js

### Render
1. Push to GitHub
2. render.com → New Web Service → Connect repo
3. Build command: `npm install`
4. Start command: `npm start`

### VPS (DigitalOcean / Vultr / Hetzner)
```bash
# Install Node.js
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Upload/clone your project
cd /var/www/pinterest-dl
npm install

# Install PM2 for process management
npm install -g pm2
pm2 start server.js --name pinterest-dl
pm2 save
pm2 startup

# Set up Nginx reverse proxy
# proxy_pass http://localhost:3000;
```

### Custom Port
```bash
PORT=8080 npm start
```

## API Endpoints

### POST /api/get-video
Fetch video info and download URLs.

**Body:** `{ "url": "https://www.pinterest.com/pin/..." }`

**Response:**
```json
{
  "success": true,
  "title": "Pin title",
  "thumbnail": "https://...",
  "qualities": [
    { "quality": "1080", "tag": "Full HD", "url": "https://...", "width": 1920, "height": 1080, "duration": 30000 },
    { "quality": "720",  "tag": "HD",      "url": "https://...", "width": 1280, "height": 720  }
  ]
}
```

### GET /api/download
Proxy-download a video file (avoids CORS issues with Pinterest CDN).

**Query params:** `url`, `filename`, `quality`

Example: `/api/download?url=https://pinimg.com/videos/...&filename=video.mp4`

### GET /api/health
Returns `{ "status": "ok", "uptime": 123 }`

## Notes

- Pinterest occasionally updates their page data structure. If downloads stop working, check the page source and update the parser in `server.js`.
- Rate limiting is set to 30 requests/minute per IP. Adjust in `server.js` if needed.
- For personal or private use only. Respect Pinterest's Terms of Service.
- Video URLs from Pinterest expire after some time — download immediately after fetching.
