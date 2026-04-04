require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { Server: SocketIOServer } = require('socket.io');

// ─── Cloud mode detection ──────────────────────────
const USE_CLOUD = !!(process.env.MONGODB_URI && process.env.R2_ENDPOINT);

const app = express();
const httpServer = http.createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});
app.use(express.json());

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
  await mongoDb.collection('users').createIndex({ email: 1 }, { unique: true }).catch(() => {});
  await mongoDb.collection('users').createIndex({ username: 1 }, { unique: true }).catch(() => {});
  await mongoDb.collection('user_libraries').createIndex({ username: 1, videoId: 1 }, { unique: true }).catch(() => {});
  await mongoDb.collection('friends').createIndex({ from: 1, to: 1 }, { unique: true }).catch(() => {});
  await mongoDb.collection('friends').createIndex({ to: 1, status: 1 }).catch(() => {});
  await mongoDb.collection('competitive_matches').createIndex({ matchId: 1 }, { unique: true }).catch(() => {});
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

// ═══════════════════════ AUTHENTICATION ═══════════════════════

const bcrypt = require('bcryptjs');
const crypto = require('crypto');

// In-memory session store (stateless tokens)
const sessions = new Map();

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Middleware to optionally attach user from token
function optionalAuth(req, res, next) {
  const token = req.headers['x-auth-token'];
  if (token && sessions.has(token)) {
    req.user = sessions.get(token);
  }
  next();
}

app.use(optionalAuth);

// Sign up
app.post('/api/auth/signup', async (req, res) => {
  const { email, username, password } = req.body;
  if (!email || !username || !password) {
    return res.status(400).json({ error: 'Email, username and password are required' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email address' });
  }
  if (username.length < 2 || username.length > 20) {
    return res.status(400).json({ error: 'Username must be 2-20 characters' });
  }
  if (!/^[a-zA-Z0-9_]+$/.test(username)) {
    return res.status(400).json({ error: 'Username can only contain letters, numbers and underscores' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  if (USE_CLOUD) {
    const users = mongoDb.collection('users');
    const existing = await users.findOne({ $or: [{ email: email.toLowerCase() }, { username }] });
    if (existing) {
      if (existing.email === email.toLowerCase()) return res.status(409).json({ error: 'Email already registered' });
      return res.status(409).json({ error: 'Username already taken' });
    }
    const hash = await bcrypt.hash(password, 10);
    await users.insertOne({
      email: email.toLowerCase(),
      username,
      passwordHash: hash,
      createdAt: new Date().toISOString(),
    });
    const token = generateToken();
    sessions.set(token, { username, email: email.toLowerCase() });
    return res.json({ token, username, email: email.toLowerCase() });
  }

  // Local mode – simple JSON file
  const usersFile = path.join(DATA_DIR, 'users.json');
  const users = readJSON(usersFile, []);
  if (users.find(u => u.email === email.toLowerCase())) return res.status(409).json({ error: 'Email already registered' });
  if (users.find(u => u.username === username)) return res.status(409).json({ error: 'Username already taken' });
  const hash = await bcrypt.hash(password, 10);
  users.push({ email: email.toLowerCase(), username, passwordHash: hash, createdAt: new Date().toISOString() });
  writeJSON(usersFile, users);
  const token = generateToken();
  sessions.set(token, { username, email: email.toLowerCase() });
  res.json({ token, username, email: email.toLowerCase() });
});

// Login
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  let user;
  if (USE_CLOUD) {
    user = await mongoDb.collection('users').findOne({ email: email.toLowerCase() });
  } else {
    const usersFile = path.join(DATA_DIR, 'users.json');
    const users = readJSON(usersFile, []);
    user = users.find(u => u.email === email.toLowerCase());
  }

  if (!user) return res.status(401).json({ error: 'No account found with that email' });
  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return res.status(401).json({ error: 'Incorrect password' });

  const token = generateToken();
  sessions.set(token, { username: user.username, email: user.email });
  res.json({ token, username: user.username, email: user.email });
});

// Account recovery – sends credentials info (simplified; real app would email)
app.post('/api/auth/recover', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  let user;
  if (USE_CLOUD) {
    user = await mongoDb.collection('users').findOne({ email: email.toLowerCase() });
  } else {
    const usersFile = path.join(DATA_DIR, 'users.json');
    const users = readJSON(usersFile, []);
    user = users.find(u => u.email === email.toLowerCase());
  }

  if (!user) return res.status(404).json({ error: 'No account found with that email' });
  // In production, send an email. For now, return the username.
  res.json({ message: 'Your username is: ' + user.username + '. Please use a new password next time you sign up, or contact support.' });
});

// Verify token (check if still logged in)
app.get('/api/auth/me', (req, res) => {
  if (req.user) return res.json({ username: req.user.username, email: req.user.email });
  res.status(401).json({ error: 'Not logged in' });
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
    '--no-warnings'
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
app.post('/api/download', (req, res) => {
  const { url, title } = req.body;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'URL required' });
  }

  const safeName = (title || 'Unknown')
    .replace(/[^a-zA-Z0-9\s\-_().&]/g, '')
    .trim()
    .substring(0, 100) || 'download';

  // Download to either songs/ (local) or /tmp (cloud)
  const destDir = USE_CLOUD ? fs.mkdtempSync(path.join(os.tmpdir(), 'djhero-')) : SONGS_DIR;
  const outputPath = path.join(destDir, `${safeName}.%(ext)s`);
  const downloadId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  downloads.set(downloadId, { status: 'downloading', title: safeName, startedAt: Date.now() });

  const proc = spawn('yt-dlp', [
    '-x',
    '--audio-format', 'mp3',
    '--audio-quality', '0',
    '--write-thumbnail',
    '--convert-thumbnails', 'jpg',
    '-o', outputPath,
    '--no-playlist',
    '--no-warnings',
    '--no-simulate',
    url
  ]);

  let stderr = '';
  proc.stderr.on('data', (data) => { stderr += data.toString(); });

  proc.on('close', async (code) => {
    if (code !== 0) {
      downloads.set(downloadId, { status: 'error', title: safeName, error: stderr });
      return;
    }

    if (USE_CLOUD) {
      try {
        await uploadToCloud(destDir, safeName);
        downloads.set(downloadId, { status: 'complete', title: safeName });
      } catch (e) {
        downloads.set(downloadId, { status: 'error', title: safeName, error: e.message });
      } finally {
        // Clean up temp files
        fs.readdirSync(destDir).forEach(f => fs.unlinkSync(path.join(destDir, f)));
        fs.rmdirSync(destDir);
      }
    } else {
      downloads.set(downloadId, { status: 'complete', title: safeName });
    }
  });

  res.json({ downloadId, title: safeName });
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
    url: `${R2_PUBLIC_URL}/songs/${encodeURIComponent(mp3File)}`,
    thumbnail: thumbnailUrl,
    createdAt: new Date(),
  };
  await mongoDb.collection('songs').updateOne(
    { filename: mp3File },
    { $set: songDoc },
    { upsert: true }
  );
}

// Check download status
app.get('/api/download/:id', (req, res) => {
  const download = downloads.get(req.params.id);
  if (!download) return res.status(404).json({ error: 'Download not found' });
  res.json(download);
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
        url: s.url,
        thumbnail: s.thumbnail,
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
        res.json({ thumbnail: publicThumbUrl });
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
    '--no-warnings'
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

// ═══════════════════════ USER LIBRARY ═══════════════════════

const LIBRARY_FILE = path.join(DATA_DIR, 'libraries.json');

// Get user's library
app.get('/api/library', async (req, res) => {
  if (!req.user) return res.json([]);

  if (USE_CLOUD) {
    const items = await mongoDb.collection('user_libraries')
      .find({ username: req.user.username })
      .sort({ addedAt: -1 }).toArray();
    return res.json(items.map(i => ({
      id: i._id,
      videoId: i.videoId,
      title: i.title,
      thumbnail: i.thumbnail || null,
      duration: i.duration || 0,
      addedAt: i.addedAt,
    })));
  }

  // Local mode
  const libs = readJSON(LIBRARY_FILE, {});
  res.json(libs[req.user.username] || []);
});

// Add song to user's library
app.post('/api/library', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Login required' });

  const { videoId, title, thumbnail, duration } = req.body;
  if (!videoId || !title) return res.status(400).json({ error: 'videoId and title required' });

  if (USE_CLOUD) {
    const col = mongoDb.collection('user_libraries');
    const existing = await col.findOne({ username: req.user.username, videoId });
    if (existing) return res.json({ success: true, id: existing._id });

    const result = await col.insertOne({
      username: req.user.username,
      videoId,
      title,
      thumbnail: thumbnail || null,
      duration: duration || 0,
      addedAt: new Date().toISOString(),
    });
    return res.json({ success: true, id: result.insertedId });
  }

  // Local mode
  const libs = readJSON(LIBRARY_FILE, {});
  if (!libs[req.user.username]) libs[req.user.username] = [];
  const existing = libs[req.user.username].find(s => s.videoId === videoId);
  if (existing) return res.json({ success: true });
  libs[req.user.username].push({
    id: Date.now().toString(36),
    videoId, title,
    thumbnail: thumbnail || null,
    duration: duration || 0,
    addedAt: new Date().toISOString(),
  });
  writeJSON(LIBRARY_FILE, libs);
  res.json({ success: true });
});

// Remove song from user's library
app.delete('/api/library/:videoId', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Login required' });

  const videoId = req.params.videoId;

  if (USE_CLOUD) {
    await mongoDb.collection('user_libraries').deleteOne({
      username: req.user.username,
      videoId,
    });
    return res.json({ success: true });
  }

  // Local mode
  const libs = readJSON(LIBRARY_FILE, {});
  if (libs[req.user.username]) {
    libs[req.user.username] = libs[req.user.username].filter(s => s.videoId !== videoId);
    writeJSON(LIBRARY_FILE, libs);
  }
  res.json({ success: true });
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
    '--no-warnings'
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

  // Guests can play but scores are not saved
  if (!req.user) {
    return res.json({ rank: 0, totalScores: 0, isPersonalBest: false, guest: true });
  }

  const username = req.user.username;
  const key = songFilename || songTitle;
  const entry = { score, grade, accuracy, maxCombo, hits, difficulty, username, date: new Date().toISOString() };

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

    // Update personal best (per user per song)
    const pbKey = username + ':' + key;
    const pb = await pbCol.findOne({ key: pbKey });
    const isPersonalBest = !pb || score > pb.score;
    if (isPersonalBest) {
      await pbCol.updateOne({ key: pbKey }, { $set: { key: pbKey, songKey: key, username, songTitle, ...entry } }, { upsert: true });
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
  leaderboard[key].songTitle = songTitle;

  leaderboard[key].scores.push(entry);
  leaderboard[key].scores.sort((a, b) => b.score - a.score);
  leaderboard[key].scores = leaderboard[key].scores.slice(0, 20);

  writeJSON(LEADERBOARD_FILE, leaderboard);

  // Update personal best (per user)
  const personalBest = readJSON(PERSONAL_BEST_FILE, {});
  const pbKey = username + ':' + key;
  if (!personalBest[pbKey] || score > personalBest[pbKey].score) {
    personalBest[pbKey] = { songTitle, username, ...entry };
    writeJSON(PERSONAL_BEST_FILE, personalBest);
  }

  const rank = leaderboard[key].scores.findIndex(s => s.score === score && s.date === entry.date) + 1;
  const isPersonalBest = personalBest[pbKey].date === entry.date;

  res.json({ rank, totalScores: leaderboard[key].scores.length, isPersonalBest });
});

// Get personal best for a song (per user)
app.get('/api/personal-best/:key', async (req, res) => {
  const songKey = decodeURIComponent(req.params.key);
  if (!req.user) return res.json(null);
  const pbKey = req.user.username + ':' + songKey;

  if (USE_CLOUD) {
    const pb = await mongoDb.collection('personal_bests').findOne({ key: pbKey });
    return res.json(pb || null);
  }

  const personalBest = readJSON(PERSONAL_BEST_FILE, {});
  res.json(personalBest[pbKey] || null);
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
      topUser: d.scores && d.scores.length > 0 ? (d.scores[0].username || 'Guest') : '-',
      top3: (d.scores || []).slice(0, 3).map(s => ({ score: s.score, grade: s.grade, username: s.username || 'Guest' })),
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
    topUser: data.scores.length > 0 ? (data.scores[0].username || 'Guest') : '-',
    top3: data.scores.slice(0, 3).map(s => ({ score: s.score, grade: s.grade, username: s.username || 'Guest' })),
  }));

  if (search) {
    entries = entries.filter(e => e.songTitle.toLowerCase().includes(search));
  }

  entries.sort((a, b) => b.plays - a.plays);
  res.json(entries);
});

const PORT = process.env.PORT || 3000;

// ═══════════════════════ FRIENDS ═══════════════════════

// Send friend request
app.post('/api/friends/add', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Login required' });
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'Username required' });
  if (username === req.user.username) return res.status(400).json({ error: 'Cannot add yourself' });

  if (USE_CLOUD) {
    const target = await mongoDb.collection('users').findOne({ username });
    if (!target) return res.status(404).json({ error: 'User not found' });
    const col = mongoDb.collection('friends');
    const existing = await col.findOne({
      $or: [
        { from: req.user.username, to: username },
        { from: username, to: req.user.username },
      ],
    });
    if (existing) {
      if (existing.status === 'accepted') return res.json({ status: 'already_friends' });
      return res.json({ status: 'already_pending' });
    }
    await col.insertOne({ from: req.user.username, to: username, status: 'pending', createdAt: new Date() });
    // Notify via socket
    const targetSocket = onlineUsers.get(username);
    if (targetSocket) targetSocket.emit('friend:request', { from: req.user.username });
    return res.json({ status: 'sent' });
  }
  res.json({ status: 'sent' });
});

// Accept friend request
app.post('/api/friends/accept', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Login required' });
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'Username required' });

  if (USE_CLOUD) {
    const result = await mongoDb.collection('friends').updateOne(
      { from: username, to: req.user.username, status: 'pending' },
      { $set: { status: 'accepted', acceptedAt: new Date() } }
    );
    if (result.matchedCount === 0) return res.status(404).json({ error: 'No pending request found' });
    const targetSocket = onlineUsers.get(username);
    if (targetSocket) targetSocket.emit('friend:accepted', { username: req.user.username });
    return res.json({ status: 'accepted' });
  }
  res.json({ status: 'accepted' });
});

// Decline friend request
app.post('/api/friends/decline', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Login required' });
  const { username } = req.body;

  if (USE_CLOUD) {
    await mongoDb.collection('friends').deleteOne({ from: username, to: req.user.username, status: 'pending' });
  }
  res.json({ status: 'declined' });
});

// Remove friend
app.delete('/api/friends/:username', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Login required' });
  const username = req.params.username;

  if (USE_CLOUD) {
    await mongoDb.collection('friends').deleteMany({
      $or: [
        { from: req.user.username, to: username },
        { from: username, to: req.user.username },
      ],
    });
  }
  res.json({ status: 'removed' });
});

// List friends + pending requests
app.get('/api/friends', async (req, res) => {
  if (!req.user) return res.json({ friends: [], incoming: [], outgoing: [] });

  if (USE_CLOUD) {
    const col = mongoDb.collection('friends');
    const all = await col.find({
      $or: [{ from: req.user.username }, { to: req.user.username }],
    }).toArray();

    const friends = [], incoming = [], outgoing = [];
    for (const r of all) {
      const other = r.from === req.user.username ? r.to : r.from;
      const isOnline = onlineUsers.has(other);
      if (r.status === 'accepted') {
        friends.push({ username: other, online: isOnline });
      } else if (r.from === req.user.username) {
        outgoing.push({ username: other });
      } else {
        incoming.push({ username: other });
      }
    }
    return res.json({ friends, incoming, outgoing });
  }
  res.json({ friends: [], incoming: [], outgoing: [] });
});

// ═══════════════════════ PROFILE ═══════════════════════

app.get('/api/profile/:username', async (req, res) => {
  const username = req.params.username;

  if (USE_CLOUD) {
    const user = await mongoDb.collection('users').findOne({ username });
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Get personal bests sorted by score
    const pbs = await mongoDb.collection('personal_bests')
      .find({ username })
      .sort({ score: -1 })
      .toArray();

    const mmr = user.mmr || 1000;
    const online = onlineUsers.has(username);

    // Check friendship status with requesting user
    let friendStatus = 'none';
    if (req.user && req.user.username !== username) {
      const friendship = await mongoDb.collection('friends').findOne({
        $or: [
          { from: req.user.username, to: username },
          { from: username, to: req.user.username },
        ],
      });
      if (friendship) {
        if (friendship.status === 'accepted') friendStatus = 'friends';
        else if (friendship.from === req.user.username) friendStatus = 'pending_sent';
        else friendStatus = 'pending_received';
      }
    } else if (req.user && req.user.username === username) {
      friendStatus = 'self';
    }

    return res.json({
      username,
      mmr,
      online,
      friendStatus,
      createdAt: user.createdAt,
      scores: pbs.map(pb => ({
        songTitle: pb.songTitle,
        songKey: pb.songKey,
        score: pb.score,
        grade: pb.grade,
        accuracy: pb.accuracy,
        maxCombo: pb.maxCombo,
        difficulty: pb.difficulty,
        date: pb.date,
        songFilename: pb.songKey || '',
      })),
    });
  }

  res.json({ username, mmr: 1000, online: false, friendStatus: 'none', scores: [] });
});

// ═══════════════════════ MMR RANKINGS ═══════════════════════

app.get('/api/rankings', async (req, res) => {
  if (USE_CLOUD) {
    const users = await mongoDb.collection('users')
      .find({ mmr: { $exists: true } })
      .sort({ mmr: -1 })
      .limit(50)
      .toArray();
    return res.json(users.map(u => ({ username: u.username, mmr: u.mmr || 1000 })));
  }
  res.json([]);
});

// ═══════════════════════ COMPETITIVE (Socket.io) ═══════════════════════

const onlineUsers = new Map();    // username → socket
const matchQueue = [];            // [{ username, socket, mmr }]
const activeMatches = new Map();  // matchId → match state
const userMatches = new Map();    // username → matchId

// ═══════════════════════ BATTLE ROYALE STATE ═══════════════════════
const brQueue = [];               // [{ username, socket, mmr }]
const activeBRMatches = new Map();// matchId → BR match state
const userBRMatches = new Map();  // username → matchId
let brQueueTimer = null;
const BR_FILL_DELAY = 30000;     // 30 seconds before filling with bots
const BR_LOBBY_TIME = 15000;     // 15 seconds for song selection
const BR_PLAYERS = 9;

const BOT_NAMES = [
  'DJ_Nexus', 'BeatBot_9k', 'SynthWaveX', 'BassDropper', 'VinylKing',
  'MixMaster_AI', 'TurntableBot', 'GrooveUnit', 'EchoBeatz', 'PhantomDJ',
  'NeonPulse', 'WubWubBot', 'The_Algorhythm', 'ByteBeat', 'DigitalDeck',
  'RoboSpin', 'AutoFade', 'LoopLord_AI', 'PixelMix', 'VoltBass',
];

function pickBotNames(count) {
  const shuffled = BOT_NAMES.slice().sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count).map(n => '[BOT] ' + n);
}

function createBRMatch(players) {
  // players = [{ username, socket, mmr, isBot }]
  const matchId = 'br_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const match = {
    matchId,
    players: players.map(p => ({
      username: p.username,
      isBot: !!p.isBot,
      mmr: p.mmr || 1000,
      song: null,
      score: 0,
      combo: 0,
      accuracy: 0,
      maxCombo: 0,
      hits: { perfect: 0, great: 0, good: 0, miss: 0 },
      eliminated: false,
      eliminatedAt: 0, // which phase (1 or 2)
      finished: false,
      keys: {},
    })),
    status: 'lobby', // lobby | playing | finished
    chosenSong: null,
    songDuration: 0,
    startTime: 0,
    lobbyTimer: null,
    eliminationTimer1: null,
    eliminationTimer2: null,
    botScoreInterval: null,
    createdAt: new Date(),
  };
  activeBRMatches.set(matchId, match);
  players.forEach(p => {
    if (!p.isBot) userBRMatches.set(p.username, matchId);
  });
  return match;
}

function startBRLobby(match) {
  match.status = 'lobby';
  const playerList = match.players.map(p => ({ username: p.username, isBot: p.isBot }));
  // Notify all human players
  match.players.forEach(p => {
    if (!p.isBot) {
      const s = onlineUsers.get(p.username);
      if (s) s.emit('br:matched', { matchId: match.matchId, players: playerList });
    }
  });
  // Start lobby countdown — after BR_LOBBY_TIME, pick song and start
  match.lobbyTimer = setTimeout(() => {
    startBRGame(match);
  }, BR_LOBBY_TIME);
}

function startBRGame(match) {
  if (match.status === 'finished') return;
  // Pick a random song from human-submitted songs
  const humanSongs = match.players.filter(p => !p.isBot && p.song).map(p => p.song);
  if (humanSongs.length === 0) {
    // No songs picked — can't start, cancel match
    match.players.forEach(p => {
      if (!p.isBot) {
        const s = onlineUsers.get(p.username);
        if (s) s.emit('br:cancelled', { reason: 'No song was selected' });
        userBRMatches.delete(p.username);
      }
    });
    activeBRMatches.delete(match.matchId);
    return;
  }
  const chosenSong = humanSongs[Math.floor(Math.random() * humanSongs.length)];
  match.chosenSong = chosenSong;
  match.songDuration = chosenSong.duration || 180;
  match.status = 'playing';
  match.startTime = Date.now();

  // Notify all humans
  match.players.forEach(p => {
    if (!p.isBot) {
      const s = onlineUsers.get(p.username);
      if (s) s.emit('br:start', { matchId: match.matchId, song: chosenSong });
    }
  });

  // Start bot score simulation
  const totalNotes = Math.round(match.songDuration * 2.5); // estimate ~2.5 notes/sec
  match.botScoreInterval = setInterval(() => {
    simulateBotScores(match, totalNotes);
    broadcastBRScores(match);
  }, 1000);

  // Schedule eliminations
  const dur = match.songDuration * 1000;
  match.eliminationTimer1 = setTimeout(() => {
    performElimination(match, 1);
  }, dur / 3);
  match.eliminationTimer2 = setTimeout(() => {
    performElimination(match, 2);
  }, (dur * 2) / 3);
  // Final results after song ends
  setTimeout(() => {
    finishBRMatch(match);
  }, dur + 3000); // 3s grace period
}

function simulateBotScores(match, totalNotes) {
  if (match.status !== 'playing') return;
  const elapsed = (Date.now() - match.startTime) / 1000;
  const progress = Math.min(elapsed / match.songDuration, 1);

  match.players.forEach(p => {
    if (!p.isBot || p.eliminated) return;
    // 95% accuracy: ~80% perfect, ~10% great, ~5% good, ~5% miss
    const notesReached = Math.floor(totalNotes * progress);
    const perfects = Math.floor(notesReached * 0.80);
    const greats = Math.floor(notesReached * 0.10);
    const goods = Math.floor(notesReached * 0.05);
    const misses = notesReached - perfects - greats - goods;

    // Score calculation: perfect=300, great=200, good=100, with multiplier
    // Simplified: avg ~270 per note * 95% hit rate * multiplier
    const avgMulti = 3; // bots maintain good combos
    const hitNotes = perfects + greats + goods;
    p.score = Math.round((perfects * 300 + greats * 200 + goods * 100) * avgMulti);
    // Add some randomness per bot so they're not identical
    const variance = 1 + (hashStr(p.username) % 100 - 50) / 500; // ±10%
    p.score = Math.round(p.score * variance);
    p.combo = p.eliminated ? 0 : Math.floor(Math.random() * 30 + 20);
    p.maxCombo = Math.max(p.maxCombo, p.combo);
    p.hits = { perfect: perfects, great: greats, good: goods, miss: misses };
    p.accuracy = hitNotes > 0 ? Math.round((hitNotes / notesReached) * 1000) / 10 : 0;

    // Simulate key presses for visual effect
    const fakeKeys = {};
    ['d', 'f', 'j', 'k'].forEach(k => { fakeKeys[k] = Math.random() < 0.3; });
    p.keys = fakeKeys;
  });
}

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function broadcastBRScores(match) {
  const scores = match.players.map(p => ({
    username: p.username,
    isBot: p.isBot,
    score: p.score,
    combo: p.combo,
    eliminated: p.eliminated,
    keys: p.keys || {},
  }));
  match.players.forEach(p => {
    if (!p.isBot) {
      const s = onlineUsers.get(p.username);
      if (s) s.emit('br:scores', { scores });
    }
  });
}

function performElimination(match, phase) {
  if (match.status !== 'playing') return;
  // Get non-eliminated players sorted by score ascending
  const alive = match.players.filter(p => !p.eliminated);
  alive.sort((a, b) => a.score - b.score);
  // Eliminate bottom 3
  const toEliminate = alive.slice(0, 3);
  toEliminate.forEach(p => {
    p.eliminated = true;
    p.eliminatedAt = phase;
  });
  // Broadcast elimination
  const eliminatedNames = toEliminate.map(p => p.username);
  match.players.forEach(p => {
    if (!p.isBot) {
      const s = onlineUsers.get(p.username);
      if (s) s.emit('br:elimination', { phase, eliminated: eliminatedNames, matchId: match.matchId });
    }
  });
}

async function finishBRMatch(match) {
  if (match.status === 'finished') return;
  match.status = 'finished';
  if (match.botScoreInterval) clearInterval(match.botScoreInterval);
  if (match.eliminationTimer1) clearTimeout(match.eliminationTimer1);
  if (match.eliminationTimer2) clearTimeout(match.eliminationTimer2);

  // Final standings sorted by score descending
  const standings = match.players.slice().sort((a, b) => b.score - a.score);
  const winner = standings[0];

  // Calculate MMR changes for human players
  // Top 3: gain MMR, bottom 6: lose MMR, scaled by placement
  const mmrChanges = {};
  if (USE_CLOUD) {
    for (const p of match.players) {
      if (p.isBot) continue;
      const rank = standings.indexOf(p) + 1;
      const user = await mongoDb.collection('users').findOne({ username: p.username });
      const currentMmr = (user && user.mmr) || 1000;
      let change = 0;
      if (rank === 1) change = 25;
      else if (rank === 2) change = 15;
      else if (rank === 3) change = 8;
      else if (rank <= 6) change = -8;
      else change = -15;
      mmrChanges[p.username] = change;
      await mongoDb.collection('users').updateOne(
        { username: p.username },
        { $set: { mmr: currentMmr + change } }
      );
    }
  }

  const resultsPayload = {
    matchId: match.matchId,
    standings: standings.map((p, i) => ({
      username: p.username,
      isBot: p.isBot,
      score: p.score,
      rank: i + 1,
      eliminated: p.eliminated,
      eliminatedAt: p.eliminatedAt,
      accuracy: p.accuracy || 0,
      maxCombo: p.maxCombo || 0,
      hits: p.hits,
      mmrChange: mmrChanges[p.username] || 0,
    })),
    winner: winner.username,
    song: match.chosenSong,
  };

  match.players.forEach(p => {
    if (!p.isBot) {
      const s = onlineUsers.get(p.username);
      if (s) s.emit('br:results', resultsPayload);
      userBRMatches.delete(p.username);
    }
  });

  setTimeout(() => activeBRMatches.delete(match.matchId), 60000);
}

function tryBRMatchmaking() {
  if (brQueue.length >= BR_PLAYERS) {
    // Enough humans — start immediately
    const players = brQueue.splice(0, BR_PLAYERS);
    const match = createBRMatch(players);
    startBRLobby(match);
    if (brQueueTimer) { clearTimeout(brQueueTimer); brQueueTimer = null; }
    return;
  }
  // Start/reset the bot fill timer
  if (brQueue.length >= 1 && !brQueueTimer) {
    brQueueTimer = setTimeout(() => {
      brQueueTimer = null;
      if (brQueue.length === 0) return;
      // Fill remaining slots with bots
      const humans = brQueue.splice(0, brQueue.length);
      const botCount = BR_PLAYERS - humans.length;
      const botNames = pickBotNames(botCount);
      const bots = botNames.map(name => ({ username: name, socket: null, mmr: 1000, isBot: true }));
      const match = createBRMatch([...humans, ...bots]);
      startBRLobby(match);
    }, BR_FILL_DELAY);
  }
  // Broadcast queue update to everyone in queue
  brQueue.forEach(p => {
    if (p.socket) p.socket.emit('br:queueUpdate', { count: brQueue.length });
  });
}

function calcElo(winnerMmr, loserMmr, k) {
  k = k || 32;
  const eW = 1 / (1 + Math.pow(10, (loserMmr - winnerMmr) / 400));
  const eL = 1 - eW;
  return { winnerGain: Math.round(k * (1 - eW)), loserLoss: Math.round(k * eL) };
}

io.on('connection', (socket) => {
  let authedUser = null;

  socket.on('auth', (data) => {
    if (!data || !data.token) return;
    const user = sessions.get(data.token);
    if (!user) return socket.emit('auth:fail');
    authedUser = user.username;
    onlineUsers.set(authedUser, socket);
    socket.emit('auth:ok', { username: authedUser });

    // If user is in an active match, sync state on reconnect
    const activeMatchId = userMatches.get(authedUser);
    if (activeMatchId) {
      const match = activeMatches.get(activeMatchId);
      if (match && match.status !== 'finished') {
        const opponent = match.player1 === authedUser ? match.player2 : match.player1;
        const isP1 = match.player1 === authedUser;
        socket.emit('match:stateSync', {
          matchId: activeMatchId,
          opponent,
          status: match.status,
          chosenSong: match.chosenSong || null,
          hasSongSelected: isP1 ? !!match.p1Song : !!match.p2Song,
          isReady: isP1 ? match.p1Ready : match.p2Ready,
        });
      } else {
        userMatches.delete(authedUser);
      }
    }
  });

  socket.on('competitive:queue', () => {
    if (!authedUser) return;
    if (matchQueue.find(q => q.username === authedUser)) return;
    const userMmr = 1000; // will be fetched from DB
    if (USE_CLOUD) {
      mongoDb.collection('users').findOne({ username: authedUser }).then(u => {
        const mmr = (u && u.mmr) || 1000;
        matchQueue.push({ username: authedUser, socket, mmr });
        tryMatchmaking();
      });
    } else {
      matchQueue.push({ username: authedUser, socket, mmr: 1000 });
      tryMatchmaking();
    }
  });

  socket.on('competitive:dequeue', () => {
    const idx = matchQueue.findIndex(q => q.username === authedUser);
    if (idx !== -1) matchQueue.splice(idx, 1);
  });

  socket.on('competitive:selectSong', (data) => {
    if (!authedUser || !data || !data.matchId) return;
    const match = activeMatches.get(data.matchId);
    if (!match) return;
    const player = match.player1 === authedUser ? 'p1' : match.player2 === authedUser ? 'p2' : null;
    if (!player) return;
    match[player + 'Song'] = data.song;
    if (match.p1Song && match.p2Song) {
      const chosen = Math.random() < 0.5 ? match.p1Song : match.p2Song;
      match.chosenSong = chosen;
      match.status = 'ready';
      const s1 = onlineUsers.get(match.player1);
      const s2 = onlineUsers.get(match.player2);
      if (s1) s1.emit('competitive:songChosen', { matchId: match.matchId, song: chosen });
      if (s2) s2.emit('competitive:songChosen', { matchId: match.matchId, song: chosen });
    }
  });

  socket.on('competitive:ready', (data) => {
    if (!authedUser || !data || !data.matchId) return;
    const match = activeMatches.get(data.matchId);
    if (!match) return;
    if (match.player1 === authedUser) match.p1Ready = true;
    else if (match.player2 === authedUser) match.p2Ready = true;
    if (match.p1Ready && match.p2Ready) {
      match.status = 'playing';
      const s1 = onlineUsers.get(match.player1);
      const s2 = onlineUsers.get(match.player2);
      if (s1) s1.emit('competitive:start', { matchId: match.matchId });
      if (s2) s2.emit('competitive:start', { matchId: match.matchId });
    }
  });

  socket.on('competitive:scoreUpdate', (data) => {
    if (!authedUser || !data || !data.matchId) return;
    const match = activeMatches.get(data.matchId);
    if (!match) return;
    const opponent = match.player1 === authedUser ? match.player2 : match.player1;
    const opponentSocket = onlineUsers.get(opponent);
    if (opponentSocket) {
      opponentSocket.emit('competitive:opponentProgress', {
        score: data.score, combo: data.combo, accuracy: data.accuracy,
      });
    }
  });

  socket.on('competitive:keyUpdate', (data) => {
    if (!authedUser || !data || !data.matchId) return;
    const match = activeMatches.get(data.matchId);
    if (!match) return;
    const opponent = match.player1 === authedUser ? match.player2 : match.player1;
    const opponentSocket = onlineUsers.get(opponent);
    if (opponentSocket) {
      opponentSocket.emit('competitive:opponentKeys', { keys: data.keys });
    }
  });

  socket.on('competitive:finish', async (data) => {
    if (!authedUser || !data || !data.matchId) return;
    const match = activeMatches.get(data.matchId);
    if (!match || match.status === 'finished') return;

    if (match.player1 === authedUser) {
      match.p1Results = data.results;
    } else if (match.player2 === authedUser) {
      match.p2Results = data.results;
    }

    // Notify opponent they've finished
    const opponent = match.player1 === authedUser ? match.player2 : match.player1;
    const opponentSocket = onlineUsers.get(opponent);
    if (opponentSocket) opponentSocket.emit('competitive:opponentFinished');

    if (match.p1Results && match.p2Results) {
      match.status = 'finished';
      userMatches.delete(match.player1);
      userMatches.delete(match.player2);
      // Determine winner
      let winner = null, loser = null;
      if (match.p1Results.score > match.p2Results.score) {
        winner = match.player1; loser = match.player2;
      } else if (match.p2Results.score > match.p1Results.score) {
        winner = match.player2; loser = match.player1;
      }

      let mmrChange = { winnerGain: 0, loserLoss: 0 };
      if (USE_CLOUD && winner) {
        const wUser = await mongoDb.collection('users').findOne({ username: winner });
        const lUser = await mongoDb.collection('users').findOne({ username: loser });
        const wMmr = (wUser && wUser.mmr) || 1000;
        const lMmr = (lUser && lUser.mmr) || 1000;
        mmrChange = calcElo(wMmr, lMmr);
        await mongoDb.collection('users').updateOne({ username: winner }, { $set: { mmr: wMmr + mmrChange.winnerGain } });
        await mongoDb.collection('users').updateOne({ username: loser }, { $set: { mmr: lMmr - mmrChange.loserLoss } });
      }

      const resultsPayload = {
        matchId: match.matchId,
        winner,
        draw: !winner,
        player1: { username: match.player1, ...match.p1Results },
        player2: { username: match.player2, ...match.p2Results },
        mmrChange: {
          winner: mmrChange.winnerGain,
          loser: -mmrChange.loserLoss,
        },
      };

      const s1 = onlineUsers.get(match.player1);
      const s2 = onlineUsers.get(match.player2);
      if (s1) s1.emit('competitive:results', resultsPayload);
      if (s2) s2.emit('competitive:results', resultsPayload);

      setTimeout(() => activeMatches.delete(match.matchId), 60000);
    }
  });

  // ─── Challenge a friend ───
  socket.on('challenge:send', (data) => {
    if (!authedUser || !data || !data.username) return;
    const targetSocket = onlineUsers.get(data.username);
    if (!targetSocket) return socket.emit('challenge:error', { error: 'User is offline' });
    const challengeId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    targetSocket.emit('challenge:received', {
      challengeId,
      from: authedUser,
      song: data.song || null,
    });
    socket.emit('challenge:sent', { challengeId, to: data.username });
  });

  socket.on('challenge:accept', (data) => {
    if (!authedUser || !data) return;
    const challengerSocket = onlineUsers.get(data.from);
    if (!challengerSocket) return;
    // Create match between challenger and accepter
    const matchId = 'match_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const match = {
      matchId,
      player1: data.from,
      player2: authedUser,
      p1Song: null, p2Song: null,
      chosenSong: null,
      p1Ready: false, p2Ready: false,
      p1Results: null, p2Results: null,
      status: 'songSelect',
      createdAt: new Date(),
    };
    activeMatches.set(matchId, match);
    userMatches.set(data.from, matchId);
    userMatches.set(authedUser, matchId);
    challengerSocket.emit('competitive:matched', { matchId, opponent: authedUser });
    socket.emit('competitive:matched', { matchId, opponent: data.from });
  });

  socket.on('challenge:decline', (data) => {
    if (!authedUser || !data) return;
    const challengerSocket = onlineUsers.get(data.from);
    if (challengerSocket) challengerSocket.emit('challenge:declined', { username: authedUser });
  });

  socket.on('competitive:abandon', () => {
    if (!authedUser) return;
    const matchId = userMatches.get(authedUser);
    if (!matchId) return;
    const match = activeMatches.get(matchId);
    if (!match || match.status === 'finished') return;

    const opponent = match.player1 === authedUser ? match.player2 : match.player1;
    const opponentSocket = onlineUsers.get(opponent);
    if (opponentSocket) opponentSocket.emit('competitive:opponentLeft', { forfeited: true, username: authedUser });

    match.status = 'finished';
    userMatches.delete(match.player1);
    userMatches.delete(match.player2);
    activeMatches.delete(matchId);
  });

  // ─── Battle Royale events ───
  socket.on('br:queue', () => {
    if (!authedUser) return;
    if (brQueue.find(q => q.username === authedUser)) return;
    if (USE_CLOUD) {
      mongoDb.collection('users').findOne({ username: authedUser }).then(u => {
        const mmr = (u && u.mmr) || 1000;
        brQueue.push({ username: authedUser, socket, mmr });
        tryBRMatchmaking();
      });
    } else {
      brQueue.push({ username: authedUser, socket, mmr: 1000 });
      tryBRMatchmaking();
    }
  });

  socket.on('br:dequeue', () => {
    const idx = brQueue.findIndex(q => q.username === authedUser);
    if (idx !== -1) brQueue.splice(idx, 1);
    if (brQueue.length === 0 && brQueueTimer) {
      clearTimeout(brQueueTimer);
      brQueueTimer = null;
    }
  });

  socket.on('br:selectSong', (data) => {
    if (!authedUser || !data || !data.matchId || !data.song) return;
    const match = activeBRMatches.get(data.matchId);
    if (!match || match.status !== 'lobby') return;
    const player = match.players.find(p => p.username === authedUser);
    if (!player || player.isBot) return;
    player.song = data.song;
  });

  socket.on('br:scoreUpdate', (data) => {
    if (!authedUser || !data || !data.matchId) return;
    const match = activeBRMatches.get(data.matchId);
    if (!match || match.status !== 'playing') return;
    const player = match.players.find(p => p.username === authedUser);
    if (!player || player.isBot) return;
    player.score = data.score || 0;
    player.combo = data.combo || 0;
    player.maxCombo = Math.max(player.maxCombo || 0, player.combo);
    if (data.accuracy !== undefined) player.accuracy = data.accuracy;
    if (data.hits) player.hits = data.hits;
  });

  socket.on('br:keyUpdate', (data) => {
    if (!authedUser || !data || !data.matchId) return;
    const match = activeBRMatches.get(data.matchId);
    if (!match || match.status !== 'playing') return;
    const player = match.players.find(p => p.username === authedUser);
    if (!player) return;
    player.keys = data.keys || {};
  });

  socket.on('br:finish', (data) => {
    if (!authedUser || !data || !data.matchId) return;
    const match = activeBRMatches.get(data.matchId);
    if (!match) return;
    const player = match.players.find(p => p.username === authedUser);
    if (!player) return;
    player.finished = true;
    if (data.results) {
      player.score = data.results.score || player.score;
      player.accuracy = data.results.accuracy || player.accuracy;
      player.maxCombo = data.results.maxCombo || player.maxCombo;
      player.hits = data.results.hits || player.hits;
    }
  });

  socket.on('br:abandon', () => {
    if (!authedUser) return;
    const matchId = userBRMatches.get(authedUser);
    if (!matchId) return;
    const match = activeBRMatches.get(matchId);
    if (!match) return;
    const player = match.players.find(p => p.username === authedUser);
    if (player) {
      player.eliminated = true;
      player.eliminatedAt = -1; // forfeited
    }
    userBRMatches.delete(authedUser);
  });

  socket.on('disconnect', () => {
    if (authedUser) {
      // Only remove if this socket is still the active one (prevents race on reconnect)
      if (onlineUsers.get(authedUser) === socket) {
        onlineUsers.delete(authedUser);

        // If in an active competitive match, notify opponent after a grace period
        const matchId = userMatches.get(authedUser);
        if (matchId) {
          setTimeout(() => {
            if (!onlineUsers.has(authedUser)) {
              const match = activeMatches.get(matchId);
              if (match && match.status !== 'finished' && match.status !== 'playing') {
                const opponent = match.player1 === authedUser ? match.player2 : match.player1;
                const opponentSocket = onlineUsers.get(opponent);
                if (opponentSocket) opponentSocket.emit('competitive:opponentLeft');
                match.status = 'finished';
                userMatches.delete(match.player1);
                userMatches.delete(match.player2);
                activeMatches.delete(matchId);
              }
            }
          }, 5000);
        }

        // Remove from BR queue
        const brIdx = brQueue.findIndex(q => q.username === authedUser);
        if (brIdx !== -1) brQueue.splice(brIdx, 1);
      }
      const idx = matchQueue.findIndex(q => q.username === authedUser);
      if (idx !== -1) matchQueue.splice(idx, 1);
    }
  });
});

function tryMatchmaking() {
  while (matchQueue.length >= 2) {
    const p1 = matchQueue.shift();
    const p2 = matchQueue.shift();
    const matchId = 'match_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const match = {
      matchId,
      player1: p1.username,
      player2: p2.username,
      p1Song: null, p2Song: null,
      chosenSong: null,
      p1Ready: false, p2Ready: false,
      p1Results: null, p2Results: null,
      status: 'songSelect',
      createdAt: new Date(),
    };
    activeMatches.set(matchId, match);
    userMatches.set(p1.username, matchId);
    userMatches.set(p2.username, matchId);
    p1.socket.emit('competitive:matched', { matchId, opponent: p2.username, opponentMmr: p2.mmr });
    p2.socket.emit('competitive:matched', { matchId, opponent: p1.username, opponentMmr: p1.mmr });
  }
}

async function start() {
  await initCloud();
  httpServer.listen(PORT, () => {
    console.log(`\n  🎧 DJ Hero is running at http://localhost:${PORT}`);
    console.log(`  📦 Mode: ${USE_CLOUD ? 'CLOUD (R2 + MongoDB)' : 'LOCAL (filesystem)'}\n`);
  });
}

start().catch(e => {
  console.error('Failed to start:', e);
  process.exit(1);
});
