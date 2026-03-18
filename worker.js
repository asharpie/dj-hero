#!/usr/bin/env node
/**
 * DJ Hero Download Worker
 *
 * Runs on your local machine to process download requests from the cloud server.
 * Your Mac can download from YouTube (residential IP), Railway can't (datacenter IP).
 *
 * Usage:
 *   node worker.js
 *
 * Environment (set in .env or export):
 *   RAILWAY_URL    — Your Railway backend URL (e.g. https://dj-hero-production.up.railway.app)
 *   WORKER_SECRET  — Shared secret for authenticating with the server
 */

require('dotenv').config();
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const RAILWAY_URL = (process.env.RAILWAY_URL || '').replace(/\/$/, '');
const WORKER_SECRET = process.env.WORKER_SECRET || 'djhero-worker-default';
const POLL_INTERVAL = 5000; // 5 seconds

if (!RAILWAY_URL) {
  console.error('❌ Set RAILWAY_URL in .env (e.g. https://dj-hero-production.up.railway.app)');
  process.exit(1);
}

console.log(`🎧 DJ Hero Worker`);
console.log(`   Server: ${RAILWAY_URL}`);
console.log(`   Polling every ${POLL_INTERVAL / 1000}s...\n`);

async function pollForJobs() {
  try {
    const res = await fetch(`${RAILWAY_URL}/api/worker/pending`, {
      headers: { 'Authorization': `Bearer ${WORKER_SECRET}` },
    });

    if (!res.ok) {
      if (res.status === 401) console.error('❌ Auth failed — check WORKER_SECRET');
      return;
    }

    const { job } = await res.json();
    if (!job) return; // No pending jobs

    console.log(`📥 Processing: "${job.title}" (${job.downloadId})`);
    console.log(`   URL: ${job.url}`);

    await processJob(job);
  } catch (e) {
    // Network error — server might be restarting, just retry
    if (e.code !== 'ECONNREFUSED') console.error('⚠️  Poll error:', e.message);
  }
}

async function processJob(job) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'djhero-worker-'));
  const outputPath = path.join(tmpDir, `${job.title}.%(ext)s`);

  try {
    // Download with yt-dlp
    await new Promise((resolve, reject) => {
      const args = [
        '-x', '--audio-format', 'mp3',
        '--write-thumbnail', '--convert-thumbnails', 'jpg',
        '-o', outputPath,
        '--no-playlist', '--no-warnings', '--no-simulate', '--no-check-certificates',
        job.url
      ];

      console.log(`   Running yt-dlp...`);
      const proc = spawn('yt-dlp', args);

      let stderr = '';
      proc.stdout.on('data', (d) => {
        const line = d.toString().trim();
        if (line) console.log(`   ${line}`);
      });
      proc.stderr.on('data', (d) => { stderr += d.toString(); });

      proc.on('close', (code) => {
        if (code !== 0) reject(new Error(stderr.trim() || `yt-dlp exited with code ${code}`));
        else resolve();
      });
    });

    // Find the downloaded MP3
    const files = fs.readdirSync(tmpDir);
    const mp3File = files.find(f => /\.mp3$/i.test(f));
    if (!mp3File) throw new Error('No MP3 file produced by yt-dlp');

    const mp3Path = path.join(tmpDir, mp3File);
    const mp3Size = fs.statSync(mp3Path).size;
    console.log(`   Downloaded: ${(mp3Size / 1048576).toFixed(1)} MB`);

    // Find thumbnail if exists
    const thumbFile = files.find(f => /\.(jpg|jpeg|png|webp)$/i.test(f));

    // Upload to server
    const formData = new FormData();
    formData.append('audio', new Blob([fs.readFileSync(mp3Path)], { type: 'audio/mpeg' }), `${job.title}.mp3`);
    formData.append('downloadId', job.downloadId);
    formData.append('title', job.title);

    if (thumbFile) {
      const thumbData = fs.readFileSync(path.join(tmpDir, thumbFile));
      formData.append('thumbnailData', thumbData.toString('base64'));
    }

    console.log(`   Uploading to server...`);
    const uploadRes = await fetch(`${RAILWAY_URL}/api/worker/complete`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${WORKER_SECRET}` },
      body: formData,
    });

    if (!uploadRes.ok) {
      const err = await uploadRes.text().catch(() => '');
      throw new Error(`Upload failed: ${uploadRes.status} ${err}`);
    }

    console.log(`✅ Done: "${job.title}"\n`);
  } catch (e) {
    console.error(`❌ Failed: "${job.title}" — ${e.message}\n`);

    // Report error back to server
    await fetch(`${RAILWAY_URL}/api/worker/error`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${WORKER_SECRET}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ downloadId: job.downloadId, error: e.message }),
    }).catch(() => {});
  } finally {
    // Clean up temp files
    try {
      fs.readdirSync(tmpDir).forEach(f => fs.unlinkSync(path.join(tmpDir, f)));
      fs.rmdirSync(tmpDir);
    } catch (_) {}
  }
}

// Poll loop
async function run() {
  while (true) {
    await pollForJobs();
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }
}

run();
