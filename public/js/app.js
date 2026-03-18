// ═══════════════════════════════════════════════════════════
// App — Main application controller, screen management, UI wiring
// ═══════════════════════════════════════════════════════════

(function () {
  'use strict';

  // ─── State ───────────────────────────────────────
  let songs = [];
  let difficulty = 'medium';
  let audioEngine = null;
  let analyzer = null;
  let game = null;
  let currentSong = null; // track which song is being played

  // ─── DOM refs ────────────────────────────────────
  const $ = function (sel) { return document.querySelector(sel); };
  const screens = {
    library: $('#screen-library'),
    setup: $('#screen-setup'),
    game: $('#screen-game'),
    results: $('#screen-results'),
    leaderboard: $('#screen-leaderboard'),
  };

  // ─── Screen management ───────────────────────────
  function showScreen(name) {
    for (var key in screens) {
      screens[key].classList.toggle('active', key === name);
    }
  }

  // ─── Toast notifications ─────────────────────────
  function toast(message, type) {
    type = type || 'info';
    var container = $('#toast-container');
    var el = document.createElement('div');
    el.className = 'toast ' + type;
    el.textContent = message;
    container.appendChild(el);
    setTimeout(function () {
      el.style.opacity = '0';
      el.style.transition = 'opacity 0.3s';
      setTimeout(function () { el.remove(); }, 300);
    }, 3500);
  }

  // ═══════════════════════ LIBRARY SCREEN ═══════════════════════

  async function loadSongs() {
    try {
      var res = await fetch('/api/songs');
      songs = await res.json();
    } catch (e) {
      songs = [];
    }
    renderSongList();
    updatePlayButton();

    // Auto-fetch thumbnails for songs that don't have one
    songs.forEach(function (s) {
      if (!s.thumbnail) {
        fetch('/api/fetch-thumbnail', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: s.title }),
        })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (data.thumbnail) {
              s.thumbnail = data.thumbnail;
              renderSongList();
            }
          })
          .catch(function () {});
      }
    });
  }

  function renderSongList() {
    var container = $('#songs-list');
    if (songs.length === 0) {
      container.innerHTML = '<p class="empty-msg">No songs yet \u2014 search and download to get started!</p>';
      return;
    }

    container.innerHTML = songs.map(function (s, i) {
      var sizeMB = (s.size / 1048576).toFixed(1);
      var artHtml = s.thumbnail
        ? '<img class="song-icon song-art" src="' + escapeHtml(s.thumbnail) + '" alt="" loading="lazy">'
        : '<div class="song-icon">\u266A</div>';
      return '<div class="song-item" data-idx="' + i + '">' +
        artHtml +
        '<div class="song-info">' +
          '<div class="song-title">' + escapeHtml(s.title) + '</div>' +
          '<div class="song-size">' + sizeMB + ' MB</div>' +
        '</div>' +
        '<button class="btn-delete" data-filename="' + escapeHtml(s.filename) + '">Delete</button>' +
      '</div>';
    }).join('');

    container.querySelectorAll('.btn-delete').forEach(function (btn) {
      btn.addEventListener('click', async function (e) {
        e.stopPropagation();
        var filename = btn.dataset.filename;
        try {
          await fetch('/api/songs/' + encodeURIComponent(filename), { method: 'DELETE' });
          toast('Deleted', 'info');
          loadSongs();
        } catch (e) {
          toast('Failed to delete', 'error');
        }
      });
    });
  }

  function updatePlayButton() {
    var btn = $('#btn-go-setup');
    btn.disabled = songs.length < 1;
  }

  // ─── YouTube Search ──────────────────────────────

  async function searchYouTube(query) {
    var container = $('#search-results');
    container.innerHTML = '<p class="empty-msg">Searching...</p>';

    try {
      var res = await fetch('/api/search?q=' + encodeURIComponent(query));
      if (!res.ok) throw new Error('Search failed');
      var results = await res.json();

      if (results.length === 0) {
        container.innerHTML = '<p class="empty-msg">No results found</p>';
        return;
      }

      container.innerHTML = results.map(function (r, i) {
        var thumbUrl = r.thumbnail ? escapeHtml(r.thumbnail) : '';
        var thumbImg = thumbUrl
          ? '<img src="' + thumbUrl + '" alt="" loading="lazy">'
          : '<img src="" alt="" style="background:#333">';
        return '<div class="search-result-item" data-idx="' + i + '">' +
          thumbImg +
          '<div class="search-result-info">' +
            '<div class="search-result-title">' + escapeHtml(r.title) + '</div>' +
            '<div class="search-result-meta">' + escapeHtml(r.channel) + ' \u00B7 ' + (r.durationStr || '?:??') + '</div>' +
          '</div>' +
          '<button class="btn-dl" data-url="' + escapeHtml(r.url) + '" data-title="' + escapeHtml(r.title) + '">Download</button>' +
        '</div>';
      }).join('');

      container.querySelectorAll('.btn-dl').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          downloadSong(btn.dataset.url, btn.dataset.title, btn);
        });
      });
    } catch (e) {
      container.innerHTML = '<p class="empty-msg">Search failed \u2014 is yt-dlp installed?</p>';
    }
  }

  async function downloadSong(url, title, btn) {
    btn.disabled = true;
    btn.textContent = '...';

    try {
      var res = await fetch('/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url, title: title }),
      });
      var data = await res.json();
      var downloadId = data.downloadId;

      var checkStatus = async function () {
        try {
          var statusRes = await fetch('/api/download/' + downloadId);
          var status = await statusRes.json();

          if (status.status === 'complete') {
            btn.textContent = '\u2713';
            toast('Downloaded: ' + title, 'success');
            loadSongs();
          } else if (status.status === 'error') {
            // Server-side download failed — offer file upload
            btn.textContent = 'Upload';
            btn.disabled = false;
            toast('Server can\'t download — use the Upload button in the library', 'error');
          } else {
            btn.textContent = '\u2193\u2193\u2193';
            setTimeout(checkStatus, 2000);
          }
        } catch (e) {
          btn.textContent = 'Error';
          btn.disabled = false;
        }
      };

      setTimeout(checkStatus, 2000);
    } catch (e) {
      btn.textContent = 'Error';
      btn.disabled = false;
      toast('Download failed', 'error');
    }
  }

  // Upload a local MP3 file
  async function uploadLocalFile(file) {
    var title = file.name.replace(/\.[^.]+$/, '');
    toast('Uploading: ' + title + '...', 'success');
    var formData = new FormData();
    formData.append('audio', file);
    formData.append('title', title);
    try {
      var res = await fetch('/api/upload', { method: 'POST', body: formData });
      var data = await res.json();
      if (data.success) {
        toast('Uploaded: ' + title, 'success');
        loadSongs();
      } else {
        toast('Upload failed: ' + (data.error || 'unknown'), 'error');
      }
    } catch (e) {
      toast('Upload failed', 'error');
    }
  }

  // ═══════════════════════ SETUP SCREEN ═══════════════════════

  let selectedSongIdx = 0;

  function populateSetupSelects() {
    var container = $('#song-card-list');
    selectedSongIdx = 0;

    container.innerHTML = songs.map(function (s, i) {
      var sizeMB = (s.size / 1048576).toFixed(1);
      var artHtml = s.thumbnail
        ? '<img class="song-card-icon song-art" src="' + escapeHtml(s.thumbnail) + '" alt="" loading="lazy">'
        : '<div class="song-card-icon">♪</div>';
      return '<div class="song-card' + (i === 0 ? ' selected' : '') + '" data-idx="' + i + '">' +
        artHtml +
        '<div class="song-card-info">' +
          '<div class="song-card-title">' + escapeHtml(s.title) + '</div>' +
          '<div class="song-card-meta">' + sizeMB + ' MB</div>' +
        '</div>' +
      '</div>';
    }).join('');

    container.querySelectorAll('.song-card').forEach(function (card) {
      card.addEventListener('click', function () {
        container.querySelectorAll('.song-card').forEach(function (c) { c.classList.remove('selected'); });
        card.classList.add('selected');
        selectedSongIdx = parseInt(card.dataset.idx);
      });
    });
  }

  // ═══════════════════════ GAME FLOW ═══════════════════════

  async function startGame() {
    var idx = selectedSongIdx;
    var song = songs[idx];

    if (!song) {
      toast('Please select a song', 'error');
      return;
    }

    currentSong = song;

    showScreen('game');

    var overlay = $('#game-overlay');
    var loadingText = $('#loading-text');
    var countdownText = $('#countdown-text');
    var pauseMenu = $('#pause-menu');

    overlay.classList.remove('hidden');
    loadingText.classList.remove('hidden');
    countdownText.textContent = '';
    pauseMenu.classList.add('hidden');

    try {
      // Initialize audio
      audioEngine = new AudioEngine();
      audioEngine.init();
      analyzer = new AudioAnalyzer();

      // Load audio
      var buffer = await audioEngine.load(song.url);

      // Analyze track
      var analysis = await analyzer.analyze(buffer);

      // Generate beatmap
      var beatmap = analyzer.generateBeatmap(analysis, difficulty);
      var duration = analysis.duration;

      // Setup game
      var canvas = $('#game-canvas');
      game = new DJGame(canvas, audioEngine);
      game.loadBeatmap(beatmap, difficulty, duration);

      // Wire callbacks
      game.onScoreUpdate = function (score, combo, crowd) {
        $('#hud-score-val').textContent = score.toLocaleString();
        $('#hud-combo-val').textContent = combo;
        $('#crowd-meter-fill').style.width = (crowd * 100) + '%';

        var multi = combo < 10 ? 1 : combo < 30 ? 2 : combo < 60 ? 4 : 8;
        $('#hud-multi-val').textContent = multi + 'x';
      };

      game.onStateChange = function (state) {
        if (state === 'paused') {
          overlay.classList.remove('hidden');
          loadingText.classList.add('hidden');
          pauseMenu.classList.remove('hidden');
          countdownText.textContent = '';
        }
      };

      game.onGameEnd = function (results) {
        setTimeout(function () {
          showResults(results);
        }, 1000);
      };

      // Loading done — countdown
      loadingText.classList.add('hidden');

      await doCountdown(countdownText, overlay);

      // Start!
      audioEngine.play(0);
      game.start();
      overlay.classList.add('hidden');

    } catch (e) {
      console.error('Game start error:', e);
      toast('Failed to start game: ' + e.message, 'error');
      showScreen('library');
    }
  }

  function doCountdown(textEl, overlay) {
    return new Promise(function (resolve) {
      var count = 3;
      textEl.textContent = count;
      var interval = setInterval(function () {
        count--;
        if (count > 0) {
          textEl.textContent = count;
        } else if (count === 0) {
          textEl.textContent = 'MIX!';
        } else {
          clearInterval(interval);
          resolve();
        }
      }, 800);
    });
  }

  function showResults(results) {
    if (game) game.stop();
    if (audioEngine) audioEngine.stop();

    showScreen('results');

    $('#results-grade').textContent = results.grade;
    $('#results-score').textContent = results.score.toLocaleString();
    $('#stat-perfect').textContent = results.hits.perfect;
    $('#stat-great').textContent = results.hits.great;
    $('#stat-good').textContent = results.hits.good;
    $('#stat-miss').textContent = results.hits.miss;
    $('#stat-combo').textContent = results.combo;
    $('#stat-accuracy').textContent = results.accuracy + '%';

    var gradeEl = $('#results-grade');
    var gradeColors = { S: '#ffea00', A: '#00e5ff', B: '#00ff88', C: '#ff9800', D: '#ff5722', F: '#ff3d5a' };
    gradeEl.style.color = gradeColors[results.grade] || '#00e5ff';
    gradeEl.style.borderColor = gradeColors[results.grade] || '#00e5ff';

    // Submit to leaderboard and show comparison
    var compEl = $('#results-comparison');
    compEl.innerHTML = '';

    if (currentSong) {
      var songKey = currentSong.filename || currentSong.title;

      // Fetch personal best first, then submit
      fetch('/api/personal-best/' + encodeURIComponent(songKey))
        .then(function (r) { return r.json(); })
        .then(function (prevBest) {
          // Submit score
          return fetch('/api/leaderboard', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              songTitle: currentSong.title,
              songFilename: currentSong.filename,
              score: results.score,
              grade: results.grade,
              accuracy: results.accuracy,
              maxCombo: results.combo,
              hits: results.hits,
              difficulty: difficulty,
            }),
          })
          .then(function (r) { return r.json(); })
          .then(function (submission) {
            var badges = [];

            if (submission.isPersonalBest) {
              badges.push('<span class="results-badge badge-pb">★ NEW PERSONAL BEST!</span>');
            }

            badges.push('<span class="results-badge badge-rank">#' + submission.rank + ' of ' + submission.totalScores + ' scores</span>');

            if (prevBest && prevBest.score && !submission.isPersonalBest) {
              var diff = results.score - prevBest.score;
              if (diff > 0) {
                badges.push('<span class="results-badge badge-improvement">+' + diff.toLocaleString() + ' vs personal best</span>');
              } else {
                badges.push('<span class="results-badge badge-improvement">Personal best: ' + prevBest.score.toLocaleString() + '</span>');
              }
            }

            compEl.innerHTML = badges.join('');
          });
        })
        .catch(function (e) {
          console.error('Leaderboard submit error:', e);
        });
    }
  }

  // ═══════════════════════ LEADERBOARD SCREEN ═══════════════════════

  var lbDebounce = null;

  async function loadLeaderboard(query) {
    var url = '/api/leaderboard';
    if (query) url += '?q=' + encodeURIComponent(query);

    try {
      var res = await fetch(url);
      var entries = await res.json();
      renderLeaderboardList(entries);
    } catch (e) {
      $('#lb-song-list').innerHTML = '<p class="lb-empty-msg">Failed to load leaderboard</p>';
    }
  }

  function renderLeaderboardList(entries) {
    var listEl = $('#lb-song-list');
    var detailEl = $('#lb-detail');
    listEl.style.display = '';
    detailEl.classList.add('hidden');

    if (entries.length === 0) {
      listEl.innerHTML = '<p class="lb-empty-msg">No songs played yet — finish a song to see it here!</p>';
      return;
    }

    // Check which songs are already downloaded
    var downloadedFiles = new Set(songs.map(function (s) { return s.filename; }));

    listEl.innerHTML = entries.map(function (e, i) {
      var isDownloaded = downloadedFiles.has(e.songFilename);
      var dlBtnHtml = '';
      if (e.songFilename) {
        if (isDownloaded) {
          dlBtnHtml = '<span class="lb-dl-btn downloaded">✓ In Library</span>';
        } else {
          dlBtnHtml = '<button class="lb-dl-btn" data-filename="' + escapeHtml(e.songFilename) + '" data-title="' + escapeHtml(e.songTitle) + '">+ Library</button>';
        }
      }

      var playBtnHtml = isDownloaded
        ? '<button class="lb-play-btn" data-filename="' + escapeHtml(e.songFilename) + '">▶ Play</button>'
        : '';

      return '<div class="lb-song-item" data-key="' + escapeHtml(e.key) + '">' +
        '<div class="lb-rank">' + (i + 1) + '</div>' +
        '<div class="lb-song-info">' +
          '<div class="lb-song-title">' + escapeHtml(e.songTitle) + '</div>' +
          '<div class="lb-song-plays">' + e.plays + ' play' + (e.plays !== 1 ? 's' : '') + '</div>' +
        '</div>' +
        '<div class="lb-song-stats">' +
          '<div class="lb-song-top-score">' + (e.topScore || 0).toLocaleString() + '</div>' +
          '<div class="lb-song-top-grade">Best: ' + (e.topGrade || '-') + '</div>' +
        '</div>' +
        '<div class="lb-song-actions">' + playBtnHtml + dlBtnHtml + '</div>' +
      '</div>';
    }).join('');

    // Click handlers for each song row (view detail)
    listEl.querySelectorAll('.lb-song-item').forEach(function (row) {
      row.addEventListener('click', function (e) {
        if (e.target.closest('.lb-dl-btn') || e.target.closest('.lb-play-btn')) return;
        var key = row.dataset.key;
        showLeaderboardDetail(key);
      });
    });

    // Play from leaderboard — launch game directly
    listEl.querySelectorAll('.lb-play-btn').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var filename = btn.dataset.filename;
        var song = songs.find(function (s) { return s.filename === filename; });
        if (song) {
          selectedSongIdx = songs.indexOf(song);
          currentSong = song;
          startGame();
        } else {
          toast('Song not in library', 'error');
        }
      });
    });

    // Download from leaderboard
    listEl.querySelectorAll('.lb-dl-btn:not(.downloaded)').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var filename = btn.dataset.filename;
        toast('"' + btn.dataset.title + '" should already be in your library. Refreshing...', 'info');
        loadSongs().then(function () {
          loadLeaderboard($('#lb-search-input').value.trim());
        });
      });
    });
  }

  async function showLeaderboardDetail(key) {
    var listEl = $('#lb-song-list');
    var detailEl = $('#lb-detail');
    var searchBar = document.querySelector('.lb-search-bar');
    listEl.style.display = 'none';
    searchBar.style.display = 'none';
    detailEl.classList.remove('hidden');

    try {
      var res = await fetch('/api/leaderboard/' + encodeURIComponent(key));
      var data = await res.json();

      $('#lb-detail-title').textContent = data.songTitle || key;
      $('#lb-detail-meta').textContent = data.plays + ' total play' + (data.plays !== 1 ? 's' : '');

      // Show play button if song is in library
      var playBtn = $('#lb-play-song');
      var songFilename = data.songFilename || key;
      var matchedSong = songs.find(function (s) { return s.filename === songFilename || s.title === (data.songTitle || key); });
      if (matchedSong) {
        playBtn.style.display = '';
        playBtn.onclick = function () {
          selectedSongIdx = songs.indexOf(matchedSong);
          currentSong = matchedSong;
          startGame();
        };
      } else {
        playBtn.style.display = 'none';
      }

      var scoresEl = $('#lb-detail-scores');
      if (!data.scores || data.scores.length === 0) {
        scoresEl.innerHTML = '<p class="lb-empty-msg">No scores yet</p>';
        return;
      }

      var gradeColors = { S: '#ffea00', A: '#00e5ff', B: '#00ff88', C: '#ff9800', D: '#ff5722', F: '#ff3d5a' };

      scoresEl.innerHTML = data.scores.map(function (s, i) {
        var date = new Date(s.date);
        var dateStr = date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        return '<div class="lb-score-row">' +
          '<div class="lb-score-rank">#' + (i + 1) + '</div>' +
          '<div class="lb-score-info">' +
            '<div class="lb-score-value">' + s.score.toLocaleString() + '</div>' +
            '<div class="lb-score-details">' +
              s.accuracy + '% · ' + s.maxCombo + ' combo · ' +
              (s.difficulty || '?') + ' · ' + dateStr +
            '</div>' +
          '</div>' +
          '<div class="lb-score-grade" style="color:' + (gradeColors[s.grade] || '#00e5ff') + '">' + s.grade + '</div>' +
        '</div>';
      }).join('');
    } catch (e) {
      $('#lb-detail-scores').innerHTML = '<p class="lb-empty-msg">Failed to load scores</p>';
    }
  }

  // ═══════════════════════ EVENT WIRING ═══════════════════════

  function init() {
    // Library: search
    $('#search-btn').addEventListener('click', function () {
      var query = $('#search-input').value.trim();
      if (query) searchYouTube(query);
    });
    $('#search-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        var query = e.target.value.trim();
        if (query) searchYouTube(query);
      }
    });

    // Library: upload MP3
    $('#upload-mp3').addEventListener('change', function () {
      var file = this.files[0];
      if (file) {
        uploadLocalFile(file);
        this.value = '';
      }
    });

    // Library: go to setup
    $('#btn-go-setup').addEventListener('click', function () {
      populateSetupSelects();
      showScreen('setup');
    });

    // Setup: back to library
    $('#btn-back-library').addEventListener('click', function () {
      showScreen('library');
    });

    // Setup: difficulty
    document.querySelectorAll('.diff-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        document.querySelectorAll('.diff-btn').forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        difficulty = btn.dataset.diff;
      });
    });

    // Setup: start game
    $('#btn-start-game').addEventListener('click', startGame);

    // Game: pause menu
    $('#btn-resume').addEventListener('click', function () {
      if (game) {
        $('#game-overlay').classList.add('hidden');
        $('#pause-menu').classList.add('hidden');
        game.resume();
      }
    });
    $('#btn-quit').addEventListener('click', function () {
      if (game) game.stop();
      if (audioEngine) audioEngine.stop();
      $('#game-overlay').classList.add('hidden');
      showScreen('library');
    });

    // Results
    $('#btn-retry').addEventListener('click', function () {
      startGame();
    });
    $('#btn-back-menu').addEventListener('click', function () {
      showScreen('library');
    });

    // Leaderboard: open
    $('#btn-go-leaderboard').addEventListener('click', function () {
      showScreen('leaderboard');
      $('#lb-search-input').value = '';
      document.querySelector('.lb-search-bar').style.display = '';
      loadLeaderboard();
    });

    // Leaderboard: back to menu
    $('#btn-back-from-lb').addEventListener('click', function () {
      showScreen('library');
    });

    // Leaderboard: back to list from detail
    $('#lb-back-to-list').addEventListener('click', function () {
      $('#lb-song-list').style.display = '';
      document.querySelector('.lb-search-bar').style.display = '';
      $('#lb-detail').classList.add('hidden');
    });

    // Leaderboard: search
    $('#lb-search-input').addEventListener('input', function () {
      clearTimeout(lbDebounce);
      var q = this.value.trim();
      lbDebounce = setTimeout(function () { loadLeaderboard(q); }, 300);
    });

    // Load songs on start
    loadSongs();
  }

  // ─── Utility ─────────────────────────────────────

  function escapeHtml(text) {
    var div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // ─── Go! ─────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
