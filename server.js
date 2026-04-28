const express = require('express');
const axios = require('axios');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const randomUseragent = require('random-useragent');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ───────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Rate limiting — 30 requests per minute per IP
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many requests. Please wait a moment.' },
});
app.use('/api/', limiter);

// ── Helpers ──────────────────────────────────────────────────

function getHeaders() {
  return {
    'User-Agent': randomUseragent.getRandom(),
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Referer': 'https://www.pinterest.com/',
    'DNT': '1',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Cache-Control': 'max-age=0',
  };
}

// Resolve short pin.it links to full pinterest.com URLs
async function resolveUrl(url) {
  if (url.includes('pin.it') || !url.includes('pinterest.com')) {
    const res = await axios.get(url, {
      headers: getHeaders(),
      maxRedirects: 5,
      timeout: 10000,
    });
    return res.request.res.responseUrl || res.config.url;
  }
  return url;
}

// Extract pin ID from URL
function extractPinId(url) {
  const match = url.match(/\/pin\/(\d+)/);
  return match ? match[1] : null;
}

// Method 1: Parse __PWS_INITIAL_STRING__ from HTML
function parseFromHtml(html) {
  // Try PWS initial string (most reliable)
  const pwsMatch = html.match(/__PWS_INITIAL_STRING__\s*=\s*"([\s\S]+?)";/);
  if (pwsMatch) {
    try {
      const decoded = JSON.parse(JSON.parse(`"${pwsMatch[1]}"`));
      // Navigate Pinterest's data structure
      const resources = decoded?.resourceResponses || [];
      for (const resource of resources) {
        const pin = resource?.response?.data;
        if (pin?.videos?.video_list) return pin;
        if (pin?.pin_resource?.data?.videos?.video_list) return pin.pin_resource.data;
      }
    } catch (e) { /* try next method */ }
  }

  // Try inline JSON script tags
  const scriptMatches = html.matchAll(/<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/g);
  for (const match of scriptMatches) {
    try {
      const data = JSON.parse(match[1]);
      if (data?.props?.pageProps?.pin?.videos) return data.props.pageProps.pin;
      if (data?.pin?.videos) return data.pin;
    } catch (e) { /* continue */ }
  }

  // Try __NEXT_DATA__
  const nextMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (nextMatch) {
    try {
      const data = JSON.parse(nextMatch[1]);
      const pin = data?.props?.pageProps?.pin;
      if (pin?.videos) return pin;
    } catch (e) { /* continue */ }
  }

  return null;
}

// Method 2: Pinterest API endpoint
async function fetchFromApi(pinId) {
  const apiUrl = `https://www.pinterest.com/resource/PinResource/get/?source_url=/pin/${pinId}/&data={"options":{"id":"${pinId}","field_set_key":"detailed"},"context":{}}`;
  const res = await axios.get(apiUrl, {
    headers: {
      ...getHeaders(),
      'X-Requested-With': 'XMLHttpRequest',
      'X-APP-VERSION': 'b1c1c19',
      'Accept': 'application/json, text/javascript, */*, q=0.01',
    },
    timeout: 10000,
  });
  return res.data?.resource_response?.data;
}

// Build quality list from Pinterest video_list object
function buildQualities(videoList) {
  const qualityOrder = [
    { key: 'V_1080P', label: '1080', tag: 'Full HD' },
    { key: 'V_720P',  label: '720',  tag: 'HD' },
    { key: 'V_480P',  label: '480',  tag: 'SD' },
    { key: 'V_360P',  label: '360',  tag: 'Low' },
    { key: 'V_HLSV4_MOBILE', label: 'HLS', tag: 'Adaptive' },
  ];

  const result = [];
  for (const q of qualityOrder) {
    const v = videoList[q.key];
    if (v && v.url) {
      result.push({
        quality: q.label,
        tag: q.tag,
        url: v.url,
        width: v.width || null,
        height: v.height || null,
        duration: v.duration || null,
      });
    }
  }

  // If none of the above matched, grab whatever is available
  if (result.length === 0) {
    const firstKey = Object.keys(videoList).find(k => videoList[k]?.url && !k.includes('HLS'));
    if (firstKey) {
      result.push({
        quality: 'Best',
        tag: 'Available',
        url: videoList[firstKey].url,
        width: null, height: null, duration: null,
      });
    }
  }

  return result;
}

// ── Routes ───────────────────────────────────────────────────

// GET video info
app.post('/api/get-video', async (req, res) => {
  let { url } = req.body;

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'A Pinterest URL is required.' });
  }

  url = url.trim();
  const isPinterest = /pinterest\.|pin\.it/i.test(url);
  if (!isPinterest) {
    return res.status(400).json({ error: 'Please provide a valid Pinterest or pin.it URL.' });
  }

  try {
    // Step 1: resolve short links
    const resolvedUrl = await resolveUrl(url);
    const pinId = extractPinId(resolvedUrl);

    let pinData = null;
    let thumbnail = '';
    let title = 'Pinterest Video';
    let qualities = [];

    // Step 2a: fetch full page HTML and parse
    try {
      const pageRes = await axios.get(resolvedUrl, {
        headers: getHeaders(),
        timeout: 12000,
        maxRedirects: 5,
      });
      pinData = parseFromHtml(pageRes.data);
    } catch (e) { /* fall through to API */ }

    // Step 2b: fallback to Pinterest resource API
    if (!pinData && pinId) {
      try {
        pinData = await fetchFromApi(pinId);
      } catch (e) { /* fall through */ }
    }

    if (!pinData) {
      return res.status(404).json({ error: 'Could not extract video data. Make sure this is a video pin.' });
    }

    // Step 3: extract fields
    title = pinData.title || pinData.description || 'Pinterest Video';
    thumbnail = pinData.images?.orig?.url
      || pinData.images?.['736x']?.url
      || pinData.image_medium_url
      || '';

    const videoList = pinData.videos?.video_list;
    if (!videoList) {
      return res.status(404).json({ error: 'No video found. This pin may be an image, not a video.' });
    }

    qualities = buildQualities(videoList);
    if (qualities.length === 0) {
      return res.status(404).json({ error: 'Video found but no downloadable formats available.' });
    }

    return res.json({
      success: true,
      pinId,
      title: title.substring(0, 150),
      thumbnail,
      qualities,
    });

  } catch (err) {
    console.error('[get-video error]', err.message);
    if (err.response?.status === 404) {
      return res.status(404).json({ error: 'Pin not found. Check the URL and try again.' });
    }
    if (err.code === 'ECONNABORTED') {
      return res.status(504).json({ error: 'Request timed out. Pinterest may be slow — try again.' });
    }
    return res.status(500).json({ error: 'Failed to fetch video. Pinterest may have changed their page structure.' });
  }
});

// Proxy download — streams the video file to the user
app.get('/api/download', async (req, res) => {
  const { url, filename, quality } = req.query;

  if (!url) return res.status(400).send('URL parameter is required.');

  // Basic validation — must be a Pinterest CDN URL
  const allowed = /pinimg\.com|pinterest\.com|pinimg\.net/i.test(url);
  if (!allowed) return res.status(403).send('Only Pinterest CDN URLs are allowed.');

  try {
    const fname = filename || `pinterest-video-${quality || 'hd'}.mp4`;
    const stream = await axios({
      method: 'GET',
      url,
      responseType: 'stream',
      timeout: 60000,
      headers: {
        'Referer': 'https://www.pinterest.com/',
        'User-Agent': randomUseragent.getRandom(),
      },
    });

    const contentLength = stream.headers['content-length'];
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    res.setHeader('Content-Type', 'video/mp4');
    if (contentLength) res.setHeader('Content-Length', contentLength);

    stream.data.pipe(res);

    stream.data.on('error', (e) => {
      console.error('[download stream error]', e.message);
      if (!res.headersSent) res.status(500).send('Stream error.');
    });

  } catch (err) {
    console.error('[download error]', err.message);
    if (!res.headersSent) res.status(500).send('Download failed. The video URL may have expired.');
  }
});

// Health check
app.get('/api/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// Serve frontend for all other routes
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`\n🎯 Pinterest Downloader running at http://localhost:${PORT}\n`);
});
