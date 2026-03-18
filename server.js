require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ─── Cloud mode detection ──────────────────────────
const USE_CLOUD = !!(process.env.MONGODB_URI && process.env.R2_ENDPOINT);

// ─── YouTube cookies (base64-encoded in env var) ───
const COOKIES_PATH = path.join(os.tmpdir(), 'yt-cookies.txt');
let ytCookiesArgs = [];
let ytExtraArgs = [];
if (process.env.YT_COOKIES_B64) {
  fs.writeFileSync(COOKIES_PATH, Buffer.from(process.env.YT_COOKIES_B64, 'base64'));
  ytCookiesArgs = ['--cookies', COOKIES_PATH];
  ytExtraArgs = ['--cookies', COOKIES_PATH, '--extractor-args', 'youtube:player_client=android'];
  console.log('  🍪 YouTube cookies loaded');
}

const app = express();
app.use(express.json({ limit: '50mb' }));

// CORS: allow Vercel frontend in production, permissive in dev
const FRONTEND_URL = process.env.FRONTEND_URL || '*';
app.use(cors({ origin: FRONTEND_URL, methods: ['GET', 'POST', 'DELETE'] }));

app.use(express.static('public'));

// ─── Local storage dirs (used when NOT in cloud mode) ──
const SONGS_DIR = path.join(__dirname, 'songs');
const DATA_DIR = path.join(__dirname, 'data');
if (!USE_CLOUD) {
  fs.mkdirSync(SONGS_DIR, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ─── Cloud clients (initialized if in cloud mode) ──
let mongoDb, s3Client, R2_BUCKET, R2_PUBLIC_URL;

async function initCloud() {
  if (!USE_CLOUD) return;

  // MongoDB
  const { MongoClient } = require('mongodb');
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  mongoDb = client.db(process.env.MONGODB_DB || 'djhero');
  await mongoDb.collection('songs').createIndex({ filename: 1 }, { unique: true }).catch(() => {});
  console.log('  ☁️  MongoDB connected');

  // Cloudflare R2
  const { S3Client } = require('@aws-sdk/client-s3');
  s3Client = new S3Client({
    region: 'auto',
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
  R2_BUCKET = process.env.R2_BUCKET || 'djhero';
  R2_PUBLIC_URL = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');
  console.log('  ☁️  R2 connected → ' + R2_PUBLIC_URL);
}

const downloads = new Map();

// Debug endpoint: check yt-dlp version and formats
app.get('/api/debug-ytdlp', (req, res) => {
  const vid = req.query.v || 'ekuwEd6iLU8';
  const args = ['--version'];
  const proc = spawn('yt-dlp', args);
  let out = '';
  proc.stdout.on('data', d => { out += d; });
  proc.on('close', () => {
    const version = out.trim();
    const fmtArgs = ['--list-formats', '--no-warnings', '--extractor-args', 'youtube:player_client=android', ...ytCookiesArgs, `https://www.youtube.com/watch?v=${vid}`];
    const proc2 = spawn('yt-dlp', fmtArgs);
    let out2 = '', err2 = '';
    proc2.stdout.on('data', d => { out2 += d; });
    proc2.stderr.on('data', d => { err2 += d; });
    proc2.on('close', () => {
      res.json({ version, args: fmtArgs, formats: out2.trim(), stderr: err2.trim(), cookiesLoaded: ytCookiesArgs.length > 0 });
    });
  });
});

// Search YouTube via yt-dlp
app.get('/api/search', (req, res) => {
  const query = req.query.q;
  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'Query required' });
  }

  const proc = spawn('yt-dlp', [
    `ytsearch10:${query}`,
    '--dump-json',
    '--flat-playlist',
    '--no-download',
    '--no-warnings',
    ...ytExtraArgs,
  ]);

  let output = '';
  let stderr = '';

  proc.stdout.on('data', (data) => { output += data.toString(); });
  proc.stderr.on('data', (data) => { stderr += data.toString(); });

  const timeout = setTimeout(() => {
    proc.kill();
    if (!res.headersSent) res.status(504).json({ error: 'Search timed out' });
  }, 30000);

  proc.on('close', (code) => {
    clearTimeout(timeout);
    if (res.headersSent) return;

    if (code !== 0 && !output.trim()) {
      return res.status(500).json({ error: 'Search failed', details: stderr });
    }

    try {
      const results = output.trim().split('\n')
        .filter(line => line.trim())
        .map(line => {
          const d = JSON.parse(line);
          return {
            id: d.id,
            title: d.title,
            url: d.url || d.webpage_url || `https://www.youtube.com/watch?v=${d.id}`,
            duration: d.duration,
            durationStr: d.duration_string || formatDuration(d.duration),
            thumbnail: d.thumbnail || (d.thumbnails && d.thumbnails.length > 0 ? d.thumbnails[0].url : null),
            channel: d.channel || d.uploader || 'Unknown'
          };
        });
      res.json(results);
    } catch (e) {
      res.status(500).json({ error: 'Failed to parse search results' });
    }
  });
});

// Download a song from YouTube
app.post('/api/download', async (req, res) => {
  const { url, title, thumbnail } = req.body;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'URL required' });
  }

  const safeName = (title || 'Unknown')
    .replace(/[^a-zA-Z0-9\s\-_().&]/g, '')
    .trim()
    .substring(0, 100) || 'download';

  const downloadId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  if (USE_CLOUD) {
    // Cloud mode: queue for local worker to pick up
    const job = {
      downloadId,
      url,
      title: safeName,
      thumbnail: thumbnail || null,
      status: 'pending',
      createdAt: new Date(),
    };
    await mongoDb.collection('download_queue').insertOne(job);
    downloads.set(downloadId, { status: 'pending', title: safeName });
    console.log(`  📋 Queued download: "${safeName}" (${downloadId})`);
  } else {
    // Local mode: download directly with yt-dlp
    downloads.set(downloadId, { status: 'downloading', title: safeName, startedAt: Date.now() });
    const outputPath = path.join(SONGS_DIR, `${safeName}.%(ext)s`);
    const proc = spawn('yt-dlp', [
      '-x', '--audio-format', 'mp3',
      '--write-thumbnail', '--convert-thumbnails', 'jpg',
      '-o', outputPath,
      '--no-playlist', '--no-warnings', '--no-simulate', '--no-check-certificates',
      ...ytExtraArgs, url
    ]);
    let stderr = '';
    proc.stderr.on('data', (data) => { stderr += data.toString(); });
    proc.on('close', (code) => {
      if (code !== 0) {
        downloads.set(downloadId, { status: 'error', title: safeName, error: stderr });
      } else {
        downloads.set(downloadId, { status: 'complete', title: safeName });
      }
    });
  }

  res.json({ downloadId, title: safeName });
});

// ─── Worker endpoints (for local machine to process download queue) ───
const WORKER_SECRET = process.env.WORKER_SECRET || 'djhero-worker-default';

function checkWorkerAuth(req, res) {
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${WORKER_SECRET}`) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

// Worker: get next pending download job
app.get('/api/worker/pending', async (req, res) => {
  if (!checkWorkerAuth(req, res)) return;
  if (!USE_CLOUD) return res.json({ job: null });

  const job = await mongoDb.collection('download_queue').findOneAndUpdate(
    { status: 'pending' },
    { $set: { status: 'downloading', claimedAt: new Date() } },
    { sort: { createdAt: 1 }, returnDocument: 'after' }
  );
  res.json({ job: job || null });
});

// Worker: submit completed download
app.post('/api/worker/complete', upload.single('audio'), async (req, res) => {
  if (!checkWorkerAuth(req, res)) return;
  if (!USE_CLOUD || !req.file) return res.status(400).json({ error: 'Missing file' });

  const { downloadId, title } = req.body;
  if (!downloadId) return res.status(400).json({ error: 'Missing downloadId' });

  const safeName = (title || 'upload').replace(/[^a-zA-Z0-9\s\-_().&]/g, '').trim().substring(0, 100);
  const filename = `${safeName}.mp3`;

  try {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    const mp3Buffer = fs.readFileSync(req.file.path);

    // Upload MP3 to R2
    await s3Client.send(new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: `songs/${filename}`,
      Body: mp3Buffer,
      ContentType: 'audio/mpeg',
    }));

    // Upload thumbnail if provided
    let thumbnailPath = null;
    if (req.body.thumbnailData) {
      const thumbBuffer = Buffer.from(req.body.thumbnailData, 'base64');
      const thumbKey = `thumbnails/${safeName}.jpg`;
      await s3Client.send(new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: thumbKey,
        Body: thumbBuffer,
        ContentType: 'image/jpeg',
      }));
      thumbnailPath = `/api/stream/${thumbKey}`;
    }

    // Save to MongoDB
    const songDoc = {
      filename,
      title: safeName,
      size: mp3Buffer.length,
      url: `/api/stream/songs/${encodeURIComponent(filename)}`,
      thumbnail: thumbnailPath,
      createdAt: new Date(),
    };
    await mongoDb.collection('songs').updateOne(
      { filename },
      { $set: songDoc },
      { upsert: true }
    );

    // Update queue + in-memory status
    await mongoDb.collection('download_queue').updateOne(
      { downloadId },
      { $set: { status: 'complete', completedAt: new Date() } }
    );
    downloads.set(downloadId, { status: 'complete', title: safeName });

    fs.unlinkSync(req.file.path);
    console.log(`  ✅ Worker completed: "${safeName}" (${(mp3Buffer.length / 1048576).toFixed(1)} MB)`);
    res.json({ success: true });
  } catch (e) {
    try { fs.unlinkSync(req.file.path); } catch (_) {}
    // Mark as error so it can be retried
    await mongoDb.collection('download_queue').updateOne(
      { downloadId },
      { $set: { status: 'pending', error: e.message } }
    ).catch(() => {});
    res.status(500).json({ error: e.message });
  }
});

// Worker: report error on a job
app.post('/api/worker/error', async (req, res) => {
  if (!checkWorkerAuth(req, res)) return;
  const { downloadId, error } = req.body;
  if (downloadId) {
    await mongoDb.collection('download_queue').updateOne(
      { downloadId },
      { $set: { status: 'error', error: error || 'Unknown error' } }
    ).catch(() => {});
    downloads.set(downloadId, { status: 'error', title: '', error: error || 'Download failed' });
  }
  res.json({ ok: true });
});

// Upload downloaded files to R2 + save metadata to MongoDB
async function uploadToCloud(dir, safeName) {
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  const files = fs.readdirSync(dir);
  const mp3File = files.find(f => /\.mp3$/i.test(f));

  if (!mp3File) throw new Error('No MP3 file found after download');

  // Upload MP3
  const mp3Buffer = fs.readFileSync(path.join(dir, mp3File));
  await s3Client.send(new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: `songs/${mp3File}`,
    Body: mp3Buffer,
    ContentType: 'audio/mpeg',
  }));

  // Upload thumbnail if it exists
  const thumbFile = files.find(f => /\.(jpg|jpeg|png|webp)$/i.test(f));
  let thumbnailUrl = null;
  if (thumbFile) {
    const thumbBuffer = fs.readFileSync(path.join(dir, thumbFile));
    const thumbKey = `thumbnails/${path.parse(mp3File).name}.jpg`;
    await s3Client.send(new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: thumbKey,
      Body: thumbBuffer,
      ContentType: 'image/jpeg',
    }));
    thumbnailUrl = `${R2_PUBLIC_URL}/${thumbKey}`;
  }

  // Save metadata to MongoDB
  const songDoc = {
    filename: mp3File,
    title: path.parse(mp3File).name,
    size: mp3Buffer.length,
    url: `/api/stream/songs/${encodeURIComponent(mp3File)}`,
    thumbnail: thumbnailUrl ? thumbnailUrl.replace(R2_PUBLIC_URL + '/', '/api/stream/') : null,
    createdAt: new Date(),
  };
  await mongoDb.collection('songs').updateOne(
    { filename: mp3File },
    { $set: songDoc },
    { upsert: true }
  );
}

// ─── Stream files from R2 via proxy (avoids CORS / public-access issues) ───
app.get('/api/stream/*', async (req, res) => {
  if (!USE_CLOUD) return res.status(404).end();
  const key = req.params[0];
  if (!key || key.includes('..')) return res.status(400).end();
  try {
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const result = await s3Client.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    if (result.ContentType) res.set('Content-Type', result.ContentType);
    if (result.ContentLength) res.set('Content-Length', String(result.ContentLength));
    res.set('Cache-Control', 'public, max-age=86400');
    result.Body.pipe(res);
  } catch (e) {
    res.status(404).end();
  }
});

// Check download status
app.get('/api/download/:id', async (req, res) => {
  // Check in-memory first (fast path)
  const memDownload = downloads.get(req.params.id);
  if (memDownload) return res.json(memDownload);

  // Check MongoDB queue (cloud mode)
  if (USE_CLOUD) {
    const job = await mongoDb.collection('download_queue').findOne({ downloadId: req.params.id });
    if (job) return res.json({ status: job.status, title: job.title, error: job.error || undefined });
  }

  res.status(404).json({ error: 'Download not found' });
});

// Upload MP3 file directly (for when yt-dlp can't run on server)
const multer = require('multer');
const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 50 * 1024 * 1024 } });
app.post('/api/upload', upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const title = (req.body.title || 'Unknown').replace(/[^a-zA-Z0-9\s\-_().&]/g, '').trim().substring(0, 100) || 'upload';
  const filename = `${title}.mp3`;

  if (USE_CLOUD) {
    try {
      const { PutObjectCommand } = require('@aws-sdk/client-s3');
      const mp3Buffer = fs.readFileSync(req.file.path);

      await s3Client.send(new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: `songs/${filename}`,
        Body: mp3Buffer,
        ContentType: 'audio/mpeg',
      }));

      const songDoc = {
        filename,
        title,
        size: mp3Buffer.length,
        url: `/api/stream/songs/${encodeURIComponent(filename)}`,
        thumbnail: null,
        createdAt: new Date(),
      };
      await mongoDb.collection('songs').updateOne(
        { filename },
        { $set: songDoc },
        { upsert: true }
      );

      fs.unlinkSync(req.file.path);
      res.json({ success: true, title });
    } catch (e) {
      try { fs.unlinkSync(req.file.path); } catch (_) {}
      res.status(500).json({ error: e.message });
    }
  } else {
    // Local mode: move file to songs dir
    const dest = path.join(SONGS_DIR, filename);
    fs.renameSync(req.file.path, dest);
    res.json({ success: true, title });
  }
});

// List all songs
app.get('/api/songs', async (req, res) => {
  if (USE_CLOUD) {
    try {
      const songs = await mongoDb.collection('songs').find().sort({ createdAt: -1 }).toArray();
      res.json(songs.map(s => ({
        filename: s.filename,
        title: s.title,
        size: s.size,
        url: s.url && R2_PUBLIC_URL && s.url.startsWith(R2_PUBLIC_URL)
          ? s.url.replace(R2_PUBLIC_URL + '/', '/api/stream/')
          : s.url,
        thumbnail: s.thumbnail && R2_PUBLIC_URL && s.thumbnail.startsWith(R2_PUBLIC_URL)
          ? s.thumbnail.replace(R2_PUBLIC_URL + '/', '/api/stream/')
          : s.thumbnail,
      })));
    } catch (e) {
      res.json([]);
    }
    return;
  }

  // Local mode
  try {
    const allFiles = fs.readdirSync(SONGS_DIR);
    const files = allFiles
      .filter(f => /\.(mp3|wav|ogg|m4a|flac|webm|opus)$/i.test(f))
      .map(f => {
        const base = path.parse(f).name;
        const thumbFile = allFiles.find(t => {
          const tBase = path.parse(t).name;
          return /\.(jpg|jpeg|png|webp)$/i.test(t) && tBase === base;
        });
        return {
          filename: f,
          title: base,
          size: fs.statSync(path.join(SONGS_DIR, f)).size,
          url: `/songs/${encodeURIComponent(f)}`,
          thumbnail: thumbFile ? `/songs/${encodeURIComponent(thumbFile)}` : null
        };
      });
    res.json(files);
  } catch (e) {
    res.json([]);
  }
});

// Serve song files
app.use('/songs', express.static(SONGS_DIR));

// Fetch thumbnail for an existing song by searching YouTube
app.post('/api/fetch-thumbnail', async (req, res) => {
  const { title } = req.body;
  if (!title || typeof title !== 'string') {
    return res.status(400).json({ error: 'Title required' });
  }

  const safeName = title.replace(/[^a-zA-Z0-9\s\-_().&]/g, '').trim().substring(0, 100) || 'Unknown';

  if (USE_CLOUD) {
    // Check if song already has thumbnail in MongoDB
    const song = await mongoDb.collection('songs').findOne({ title: safeName });
    if (song && song.thumbnail) {
      return res.json({ thumbnail: song.thumbnail });
    }

    // Search YouTube for thumbnail
    return fetchThumbFromYT(safeName, async (thumbUrl) => {
      if (!thumbUrl) return res.json({ thumbnail: null });

      // Download thumbnail to temp, upload to R2
      try {
        const thumbBuffer = await downloadUrl(thumbUrl);
        const { PutObjectCommand } = require('@aws-sdk/client-s3');
        const thumbKey = `thumbnails/${safeName}.jpg`;
        await s3Client.send(new PutObjectCommand({
          Bucket: R2_BUCKET,
          Key: thumbKey,
          Body: thumbBuffer,
          ContentType: 'image/jpeg',
        }));
        const publicThumbUrl = `${R2_PUBLIC_URL}/${thumbKey}`;
        // Update MongoDB
        await mongoDb.collection('songs').updateOne(
          { title: safeName },
          { $set: { thumbnail: publicThumbUrl } }
        );
        res.json({ thumbnail: `/api/stream/${thumbKey}` });
      } catch (e) {
        res.json({ thumbnail: null });
      }
    });
  }

  // Local mode

  // Check if thumbnail already exists
  const existingThumb = ['jpg', 'jpeg', 'png', 'webp'].find(ext =>
    fs.existsSync(path.join(SONGS_DIR, `${safeName}.${ext}`))
  );
  if (existingThumb) {
    return res.json({ thumbnail: `/songs/${encodeURIComponent(safeName + '.' + existingThumb)}` });
  }

  // Search YouTube for the title and grab the first result's thumbnail URL
  const proc = spawn('yt-dlp', [
    `ytsearch1:${title}`,
    '--dump-json',
    '--flat-playlist',
    '--no-download',
    '--no-warnings',
    ...ytExtraArgs,
  ]);

  let output = '';
  proc.stdout.on('data', (data) => { output += data.toString(); });

  const timeout = setTimeout(() => { proc.kill(); }, 15000);

  proc.on('close', (code) => {
    clearTimeout(timeout);
    if (res.headersSent) return;

    try {
      const line = output.trim().split('\n')[0];
      if (!line) return res.json({ thumbnail: null });
      const d = JSON.parse(line);
      const thumbUrl = d.thumbnail || (d.thumbnails && d.thumbnails.length > 0 ? d.thumbnails[d.thumbnails.length - 1].url : null);

      if (!thumbUrl) return res.json({ thumbnail: null });

      // Download the thumbnail image
      const https = require('https');
      const http = require('http');
      const outPath = path.join(SONGS_DIR, `${safeName}.jpg`);
      const protocol = thumbUrl.startsWith('https') ? https : http;
      const file = fs.createWriteStream(outPath);

      protocol.get(thumbUrl, (response) => {
        // Follow redirects
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          const redirectProto = response.headers.location.startsWith('https') ? https : http;
          redirectProto.get(response.headers.location, (r2) => {
            r2.pipe(file);
            file.on('finish', () => {
              file.close();
              res.json({ thumbnail: `/songs/${encodeURIComponent(safeName + '.jpg')}` });
            });
          }).on('error', () => res.json({ thumbnail: null }));
          return;
        }
        response.pipe(file);
        file.on('finish', () => {
          file.close();
          res.json({ thumbnail: `/songs/${encodeURIComponent(safeName + '.jpg')}` });
        });
      }).on('error', () => res.json({ thumbnail: null }));
    } catch (e) {
      res.json({ thumbnail: null });
    }
  });
});

// Delete a song
app.delete('/api/songs/:filename', async (req, res) => {
  const filename = path.basename(req.params.filename);

  if (USE_CLOUD) {
    try {
      const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
      const base = path.parse(filename).name;
      // Delete MP3 and thumbnail from R2
      await s3Client.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: `songs/${filename}` })).catch(() => {});
      await s3Client.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: `thumbnails/${base}.jpg` })).catch(() => {});
      // Remove from MongoDB
      await mongoDb.collection('songs').deleteOne({ filename });
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: 'Failed to delete' });
    }
    return;
  }

  // Local mode
  const filepath = path.join(SONGS_DIR, filename);

  const realPath = path.resolve(filepath);
  if (!realPath.startsWith(path.resolve(SONGS_DIR))) {
    return res.status(403).json({ error: 'Invalid path' });
  }

  try {
    if (fs.existsSync(filepath)) {
      fs.unlinkSync(filepath);
      // Also remove thumbnail if it exists
      const base = path.parse(filename).name;
      ['jpg', 'jpeg', 'png', 'webp'].forEach(ext => {
        const thumbPath = path.join(SONGS_DIR, `${base}.${ext}`);
        if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
      });
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'File not found' });
    }
  } catch (e) {
    res.status(500).json({ error: 'Failed to delete' });
  }
});

function formatDuration(seconds) {
  if (!seconds) return '?:??';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// Helper: search YouTube for a thumbnail URL, calls cb(url)
function fetchThumbFromYT(title, cb) {
  const proc = spawn('yt-dlp', [
    `ytsearch1:${title}`,
    '--dump-json',
    '--flat-playlist',
    '--no-download',
    '--no-warnings',
    ...ytExtraArgs,
  ]);

  let output = '';
  proc.stdout.on('data', (data) => { output += data.toString(); });

  const timeout = setTimeout(() => { proc.kill(); }, 15000);

  proc.on('close', () => {
    clearTimeout(timeout);
    try {
      const line = output.trim().split('\n')[0];
      if (!line) return cb(null);
      const d = JSON.parse(line);
      const thumbUrl = d.thumbnail || (d.thumbnails && d.thumbnails.length > 0 ? d.thumbnails[d.thumbnails.length - 1].url : null);
      cb(thumbUrl);
    } catch (e) {
      cb(null);
    }
  });
}

// Helper: download a URL to a Buffer
function downloadUrl(url) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const http = require('http');
    const protocol = url.startsWith('https') ? https : http;

    const doGet = (targetUrl) => {
      const proto = targetUrl.startsWith('https') ? https : http;
      proto.get(targetUrl, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          return doGet(response.headers.location);
        }
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve(Buffer.concat(chunks)));
        response.on('error', reject);
      }).on('error', reject);
    };

    doGet(url);
  });
}

// ═══════════════════════ LEADERBOARD ═══════════════════════

const LEADERBOARD_FILE = path.join(DATA_DIR, 'leaderboard.json');
const PERSONAL_BEST_FILE = path.join(DATA_DIR, 'personal_best.json');

function readJSON(filepath, fallback) {
  try {
    if (fs.existsSync(filepath)) {
      return JSON.parse(fs.readFileSync(filepath, 'utf8'));
    }
  } catch (e) {}
  return fallback;
}

function writeJSON(filepath, data) {
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf8');
}

// Submit a score
app.post('/api/leaderboard', async (req, res) => {
  const { songTitle, songFilename, score, grade, accuracy, maxCombo, hits, difficulty } = req.body;
  if (!songTitle || typeof score !== 'number') {
    return res.status(400).json({ error: 'Invalid submission' });
  }

  const key = songFilename || songTitle;
  const entry = { score, grade, accuracy, maxCombo, hits, difficulty, date: new Date().toISOString() };

  if (USE_CLOUD) {
    const col = mongoDb.collection('leaderboard');
    const pbCol = mongoDb.collection('personal_bests');

    // Upsert the leaderboard doc
    let doc = await col.findOne({ key });
    if (!doc) {
      doc = { key, songTitle, songFilename: songFilename || '', plays: 0, scores: [] };
      await col.insertOne(doc);
    }

    await col.updateOne({ key }, {
      $inc: { plays: 1 },
      $set: { songTitle },
      $push: { scores: { $each: [entry], $sort: { score: -1 }, $slice: 20 } }
    });

    // Update personal best
    const pb = await pbCol.findOne({ key });
    const isPersonalBest = !pb || score > pb.score;
    if (isPersonalBest) {
      await pbCol.updateOne({ key }, { $set: { key, songTitle, ...entry } }, { upsert: true });
    }

    const updated = await col.findOne({ key });
    const rank = updated.scores.findIndex(s => s.score === score && s.date === entry.date) + 1;
    return res.json({ rank, totalScores: updated.scores.length, isPersonalBest });
  }

  // Local mode
  const leaderboard = readJSON(LEADERBOARD_FILE, {});

  if (!leaderboard[key]) {
    leaderboard[key] = { songTitle, songFilename: songFilename || '', plays: 0, scores: [] };
  }

  leaderboard[key].plays++;
  leaderboard[key].songTitle = songTitle; // keep title fresh

  leaderboard[key].scores.push(entry);
  // Keep top 20 scores per song
  leaderboard[key].scores.sort((a, b) => b.score - a.score);
  leaderboard[key].scores = leaderboard[key].scores.slice(0, 20);

  writeJSON(LEADERBOARD_FILE, leaderboard);

  // Update personal best
  const personalBest = readJSON(PERSONAL_BEST_FILE, {});
  if (!personalBest[key] || score > personalBest[key].score) {
    personalBest[key] = { songTitle, ...entry };
    writeJSON(PERSONAL_BEST_FILE, personalBest);
  }

  // Return rank info
  const rank = leaderboard[key].scores.findIndex(s => s.score === score && s.date === entry.date) + 1;
  const isPersonalBest = personalBest[key].date === entry.date;

  res.json({ rank, totalScores: leaderboard[key].scores.length, isPersonalBest });
});

// Get personal best for a song
app.get('/api/personal-best/:key', async (req, res) => {
  const key = decodeURIComponent(req.params.key);

  if (USE_CLOUD) {
    const pb = await mongoDb.collection('personal_bests').findOne({ key });
    return res.json(pb || null);
  }

  const personalBest = readJSON(PERSONAL_BEST_FILE, {});
  res.json(personalBest[key] || null);
});

// Get leaderboard for a specific song
app.get('/api/leaderboard/:key', async (req, res) => {
  const key = decodeURIComponent(req.params.key);

  if (USE_CLOUD) {
    const entry = await mongoDb.collection('leaderboard').findOne({ key });
    if (!entry) return res.json({ songTitle: key, plays: 0, scores: [] });
    return res.json(entry);
  }

  const leaderboard = readJSON(LEADERBOARD_FILE, {});
  const entry = leaderboard[key];
  if (!entry) return res.json({ songTitle: key, plays: 0, scores: [] });
  res.json(entry);
});

// Get global leaderboard (all songs, sorted by play count)
app.get('/api/leaderboard', async (req, res) => {
  const search = (req.query.q || '').toLowerCase();

  if (USE_CLOUD) {
    const query = search ? { songTitle: { $regex: search, $options: 'i' } } : {};
    const docs = await mongoDb.collection('leaderboard').find(query).sort({ plays: -1 }).toArray();
    return res.json(docs.map(d => ({
      key: d.key,
      songTitle: d.songTitle,
      songFilename: d.songFilename,
      plays: d.plays,
      topScore: d.scores && d.scores.length > 0 ? d.scores[0].score : 0,
      topGrade: d.scores && d.scores.length > 0 ? d.scores[0].grade : '-',
    })));
  }

  const leaderboard = readJSON(LEADERBOARD_FILE, {});

  let entries = Object.entries(leaderboard).map(([key, data]) => ({
    key,
    songTitle: data.songTitle,
    songFilename: data.songFilename,
    plays: data.plays,
    topScore: data.scores.length > 0 ? data.scores[0].score : 0,
    topGrade: data.scores.length > 0 ? data.scores[0].grade : '-',
  }));

  if (search) {
    entries = entries.filter(e => e.songTitle.toLowerCase().includes(search));
  }

  entries.sort((a, b) => b.plays - a.plays);
  res.json(entries);
});

const PORT = process.env.PORT || 3000;

async function start() {
  await initCloud();
  app.listen(PORT, () => {
    console.log(`\n  🎧 DJ Hero is running at http://localhost:${PORT}`);
    console.log(`  📦 Mode: ${USE_CLOUD ? 'CLOUD (R2 + MongoDB)' : 'LOCAL (filesystem)'}\n`);
  });
}

start().catch(e => {
  console.error('Failed to start:', e);
  process.exit(1);
});
