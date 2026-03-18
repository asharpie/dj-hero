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
  let currentUser = null; // { username, email } or null for guest

  // ─── Auth helpers ────────────────────────────────
  function getToken() { return localStorage.getItem('djhero_token'); }
  function setToken(t) { if (t) localStorage.setItem('djhero_token', t); else localStorage.removeItem('djhero_token'); }
  function authHeaders() {
    var h = { 'Content-Type': 'application/json' };
    var t = getToken();
    if (t) h['x-auth-token'] = t;
    return h;
  }

  // ─── DOM refs ────────────────────────────────────
  const $ = function (sel) { return document.querySelector(sel); };
  const screens = {
    auth: $('#screen-auth'),
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
      container.innerHTML = '<p class="empty-msg">Your library is empty. Search for a song above and hit \u25B6 Play, or download songs to build your library!</p>';
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

  // ─── Popular Songs (auto-loaded on start) ───────

  var POPULAR_QUERIES = [
    'top hits 2026', 'popular songs right now', 'trending music',
    'best edm drops', 'hip hop bangers', 'pop hits playlist',
  ];

  async function loadPopularSongs() {
    var query = POPULAR_QUERIES[Math.floor(Math.random() * POPULAR_QUERIES.length)];
    try {
      var res = await fetch('/api/search?q=' + encodeURIComponent(query));
      if (!res.ok) return;
      var results = await res.json();
      if (results.length === 0) return;

      var container = $('#search-results');
      var searchResults = results;

      container.innerHTML = '<p class="search-heading">Popular right now</p>' + results.map(function (r, i) {
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
          '<button class="btn-play-stream" data-idx="' + i + '">\u25B6 Play</button>' +
        '</div>';
      }).join('');

      container.querySelectorAll('.btn-play-stream').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          var r = searchResults[parseInt(btn.dataset.idx)];
          streamAndPlay(r.id, r.title, r.thumbnail, r.duration);
        });
      });
    } catch (e) {
      // Silently fail — user can still search manually
    }
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

      // Store search results for play buttons
      var searchResults = results;

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
          '<button class="btn-play-stream" data-idx="' + i + '">\u25B6 Play</button>' +
        '</div>';
      }).join('');

      container.querySelectorAll('.btn-play-stream').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          var r = searchResults[parseInt(btn.dataset.idx)];
          streamAndPlay(r.id, r.title, r.thumbnail, r.duration);
        });
      });
    } catch (e) {
      container.innerHTML = '<p class="empty-msg">Search failed \u2014 please try again</p>';
    }
  }

  // Stream a YouTube song and launch the game directly
  function streamAndPlay(videoId, title, thumbnail, durationSec) {
    var streamSong = {
      filename: videoId + '.mp3',
      title: title,
      size: 0,
      videoId: videoId,
      thumbnail: thumbnail || null,
      durationHint: durationSec || 0,
    };
    currentSong = streamSong;
    startGame(streamSong);
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

  async function startGame(overrideSong) {
    var song = overrideSong || songs[selectedSongIdx];

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
      analyzer = new AudioAnalyzer();
      var analysis, duration;

      if (song.videoId) {
        // ─── YouTube streaming mode ───
        audioEngine = new YouTubeAudioEngine();
        audioEngine.init();
        await audioEngine.load(song.videoId);

        duration = audioEngine.getDuration() || song.durationHint || 180;
        analysis = analyzer.analyzeAlgorithmic(duration);
      } else {
        // ─── Library mode (local/cloud audio file) ───
        audioEngine = new AudioEngine();
        audioEngine.init();
        var buffer = await audioEngine.load(song.url);
        analysis = await analyzer.analyze(buffer);
        duration = analysis.duration;
      }

      // Generate beatmap
      var beatmap = analyzer.generateBeatmap(analysis, difficulty);

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

    if (!currentUser) {
      compEl.innerHTML = '<span class="results-badge badge-rank">Playing as Guest — scores not saved</span>';
      return;
    }

    if (currentSong) {
      var songKey = currentSong.filename || currentSong.title;

      // Fetch personal best first, then submit
      fetch('/api/personal-best/' + encodeURIComponent(songKey), { headers: authHeaders() })
        .then(function (r) { return r.json(); })
        .then(function (prevBest) {
          // Submit score
          return fetch('/api/leaderboard', {
            method: 'POST',
            headers: authHeaders(),
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
          '<div class="lb-song-top-grade">Best: ' + (e.topGrade || '-') + ' <span class="lb-score-username">by ' + escapeHtml(e.topUser || 'Guest') + '</span></div>' +
          (e.top3 && e.top3.length > 1 ? '<div class="lb-top3">' + e.top3.map(function (t, ti) {
            return '<span class="lb-top3-entry">' + (ti + 1) + '. ' + escapeHtml(t.username) + ' (' + t.score.toLocaleString() + ')</span>';
          }).join(' ') + '</div>' : '') +
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
        var user = s.username || 'Guest';
        var detailHtml = '';
        if (s.hits) {
          detailHtml = '<div class="lb-score-detail" id="lb-detail-' + i + '">' +
            '<div class="detail-grid">' +
              '<div>Perfect: <span>' + (s.hits.perfect || 0) + '</span></div>' +
              '<div>Great: <span>' + (s.hits.great || 0) + '</span></div>' +
              '<div>Good: <span>' + (s.hits.good || 0) + '</span></div>' +
              '<div>Miss: <span>' + (s.hits.miss || 0) + '</span></div>' +
              '<div>Max Combo: <span>' + (s.maxCombo || 0) + '</span></div>' +
              '<div>Accuracy: <span>' + (s.accuracy || 0) + '%</span></div>' +
            '</div>' +
          '</div>';
        }
        return '<div class="lb-score-row" data-detail="lb-detail-' + i + '">' +
          '<div class="lb-score-rank">#' + (i + 1) + '</div>' +
          '<div class="lb-score-info">' +
            '<div class="lb-score-value">' + s.score.toLocaleString() + ' <span class="lb-score-username">' + escapeHtml(user) + '</span></div>' +
            '<div class="lb-score-details">' +
              s.accuracy + '% · ' + s.maxCombo + ' combo · ' +
              (s.difficulty || '?') + ' · ' + dateStr +
            '</div>' +
          '</div>' +
          '<div class="lb-score-grade" style="color:' + (gradeColors[s.grade] || '#00e5ff') + '">' + s.grade + '</div>' +
        '</div>' + detailHtml;
      }).join('');

      // Expandable score rows
      scoresEl.querySelectorAll('.lb-score-row').forEach(function (row) {
        row.addEventListener('click', function () {
          var detailId = row.dataset.detail;
          var detail = document.getElementById(detailId);
          if (detail) detail.classList.toggle('open');
        });
      });
    } catch (e) {
      $('#lb-detail-scores').innerHTML = '<p class="lb-empty-msg">Failed to load scores</p>';
    }
  }

  // ═══════════════════════ AUTH LOGIC ═══════════════════════

  function showAuthError(msg) {
    var el = $('#auth-error');
    el.textContent = msg;
    el.classList.remove('hidden');
  }
  function hideAuthError() { $('#auth-error').classList.add('hidden'); }

  function enterApp(user) {
    currentUser = user;
    if (user) {
      $('#user-badge').textContent = user.username;
      $('#btn-logout').style.display = '';
    } else {
      $('#user-badge').textContent = 'Guest';
      $('#btn-logout').textContent = 'Exit Guest';
      $('#btn-logout').style.display = '';
    }
    showScreen('library');
    loadSongs();
    loadPopularSongs();
  }

  async function tryAutoLogin() {
    var token = getToken();
    if (!token) return false;
    try {
      var res = await fetch('/api/auth/me', { headers: { 'x-auth-token': token } });
      if (!res.ok) { setToken(null); return false; }
      var data = await res.json();
      currentUser = { username: data.username, email: data.email };
      return true;
    } catch (e) { setToken(null); return false; }
  }

  function setupAuthHandlers() {
    // Tab switching
    document.querySelectorAll('.auth-tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        document.querySelectorAll('.auth-tab').forEach(function (t) { t.classList.remove('active'); });
        tab.classList.add('active');
        hideAuthError();
        var target = tab.dataset.tab;
        $('#login-form').classList.toggle('hidden', target !== 'login');
        $('#signup-form').classList.toggle('hidden', target !== 'signup');
        $('#recover-form').classList.add('hidden');
      });
    });

    // Login
    $('#login-form').addEventListener('submit', async function (e) {
      e.preventDefault();
      hideAuthError();
      var email = $('#login-email').value.trim();
      var password = $('#login-password').value;
      try {
        var res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email, password: password }),
        });
        var data = await res.json();
        if (!res.ok) { showAuthError(data.error || 'Login failed'); return; }
        setToken(data.token);
        enterApp({ username: data.username, email: email });
      } catch (err) { showAuthError('Connection error'); }
    });

    // Signup
    $('#signup-form').addEventListener('submit', async function (e) {
      e.preventDefault();
      hideAuthError();
      var username = $('#signup-username').value.trim();
      var email = $('#signup-email').value.trim();
      var password = $('#signup-password').value;
      try {
        var res = await fetch('/api/auth/signup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: username, email: email, password: password }),
        });
        var data = await res.json();
        if (!res.ok) { showAuthError(data.error || 'Signup failed'); return; }
        setToken(data.token);
        enterApp({ username: data.username, email: email });
      } catch (err) { showAuthError('Connection error'); }
    });

    // Forgot
    $('#btn-forgot').addEventListener('click', function () {
      hideAuthError();
      $('#login-form').classList.add('hidden');
      $('#signup-form').classList.add('hidden');
      $('#recover-form').classList.remove('hidden');
      document.querySelectorAll('.auth-tab').forEach(function (t) { t.classList.remove('active'); });
    });

    // Recover
    $('#recover-form').addEventListener('submit', async function (e) {
      e.preventDefault();
      hideAuthError();
      var email = $('#recover-email').value.trim();
      try {
        var res = await fetch('/api/auth/recover', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email }),
        });
        var data = await res.json();
        var resultEl = $('#recover-result');
        if (!res.ok) {
          resultEl.textContent = data.error || 'No account found';
          resultEl.style.color = 'var(--red)';
        } else {
          resultEl.textContent = 'Your username is: ' + data.username + '. Use it to log in with your email.';
          resultEl.style.color = 'var(--green)';
        }
        resultEl.classList.remove('hidden');
      } catch (err) { showAuthError('Connection error'); }
    });

    // Back to login from recover
    $('#btn-back-login').addEventListener('click', function () {
      hideAuthError();
      $('#recover-form').classList.add('hidden');
      $('#recover-result').classList.add('hidden');
      $('#login-form').classList.remove('hidden');
      document.querySelectorAll('.auth-tab').forEach(function (t) { t.classList.remove('active'); });
      document.querySelector('.auth-tab[data-tab="login"]').classList.add('active');
    });

    // Guest
    $('#btn-guest').addEventListener('click', function () {
      setToken(null);
      enterApp(null);
    });

    // Logout
    $('#btn-logout').addEventListener('click', function () {
      setToken(null);
      currentUser = null;
      showScreen('auth');
    });
  }

  // ═══════════════════════ EVENT WIRING ═══════════════════════

  function init() {
    // Setup auth
    setupAuthHandlers();

    // Try auto-login
    tryAutoLogin().then(function (loggedIn) {
      if (loggedIn) {
        enterApp(currentUser);
      }
      // else stay on auth screen
    });

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
