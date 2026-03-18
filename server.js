require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ─── Cloud mode detection ──────────────────────────
const USE_CLOUD = !!(process.env.MONGODB_URI && process.env.R2_ENDPOINT);

const app = express();
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
