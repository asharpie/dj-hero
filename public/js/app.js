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
    profile: $('#screen-profile'),
    friends: $('#screen-friends'),
    competitive: $('#screen-competitive'),
  };

  // ─── Screen management ───────────────────────────
  var _suppressHash = false;
  function showScreen(name) {
    for (var key in screens) {
      screens[key].classList.toggle('active', key === name);
    }
    if (!_suppressHash && location.hash !== '#' + name) {
      history.pushState(null, '', '#' + name);
    }
  }

  // Screens that require in-progress game state — fall back to library on refresh
  var ephemeralScreens = { game: true, setup: true, results: true };

  function navigateToHash() {
    var hash = location.hash.replace('#', '');
    if (!hash || !screens[hash]) { return false; }
    if (ephemeralScreens[hash]) { hash = 'library'; }
    if (hash !== 'auth' && !currentUser && !getToken()) {
      showScreen('auth');
      return true;
    }
    _suppressHash = true;
    showScreen(hash);
    _suppressHash = false;
    if (hash === 'leaderboard') { loadLeaderboard(); }
    if (hash === 'friends') { loadFriends(); }
    if (hash === 'competitive') { loadRankings(); }
    return true;
  }

  window.addEventListener('hashchange', function () {
    navigateToHash();
  });

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
    if (!currentUser) {
      songs = [];
      renderSongList();
      updatePlayButton();
      return;
    }
    try {
      var res = await fetch('/api/library', { headers: authHeaders() });
      var items = await res.json();
      songs = items.map(function (s) {
        return {
          videoId: s.videoId,
          filename: s.videoId + '.mp3',
          title: s.title,
          thumbnail: s.thumbnail || null,
          size: 0,
          durationHint: s.duration || 0,
        };
      });
    } catch (e) {
      songs = [];
    }
    renderSongList();
    updatePlayButton();
  }

  function renderSongList() {
    var container = $('#songs-list');
    if (!currentUser) {
      container.innerHTML = '<p class="empty-msg">Log in to save songs to your library.</p>';
      return;
    }
    if (songs.length === 0) {
      container.innerHTML = '<p class="empty-msg">Your library is empty. Search for a song above and hit + to save it!</p>';
      return;
    }

    container.innerHTML = songs.map(function (s, i) {
      var artHtml = s.thumbnail
        ? '<img class="song-icon song-art" src="' + escapeHtml(s.thumbnail) + '" alt="" loading="lazy">'
        : '<div class="song-icon">\u266A</div>';
      return '<div class="song-item" data-idx="' + i + '">' +
        artHtml +
        '<div class="song-info">' +
          '<div class="song-title">' + escapeHtml(s.title) + '</div>' +
        '</div>' +
        '<button class="btn-play-lib" data-idx="' + i + '">\u25B6</button>' +
        '<button class="btn-delete" data-videoid="' + escapeHtml(s.videoId) + '">\u2715</button>' +
      '</div>';
    }).join('');

    container.querySelectorAll('.btn-play-lib').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var s = songs[parseInt(btn.dataset.idx)];
        streamAndPlay(s.videoId, s.title, s.thumbnail, s.durationHint);
      });
    });

    container.querySelectorAll('.btn-delete').forEach(function (btn) {
      btn.addEventListener('click', async function (e) {
        e.stopPropagation();
        var vid = btn.dataset.videoid;
        try {
          await fetch('/api/library/' + encodeURIComponent(vid), {
            method: 'DELETE',
            headers: authHeaders(),
          });
          toast('Removed from library', 'info');
          loadSongs();
        } catch (e) {
          toast('Failed to delete', 'error');
        }
      });
    });
  }

  function addToLibrary(videoId, title, thumbnail, duration) {
    if (!currentUser) return;
    fetch('/api/library', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ videoId: videoId, title: title, thumbnail: thumbnail || null, duration: duration || 0 }),
    }).then(function () { loadSongs(); }).catch(function () {});
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
        var saveBtn = currentUser ? '<button class="btn-save-lib" data-idx="' + i + '" title="Save to Library">+</button>' : '';
        return '<div class="search-result-item" data-idx="' + i + '">' +
          thumbImg +
          '<div class="search-result-info">' +
            '<div class="search-result-title">' + escapeHtml(r.title) + '</div>' +
            '<div class="search-result-meta">' + escapeHtml(r.channel) + ' \u00B7 ' + (r.durationStr || '?:??') + '</div>' +
          '</div>' +
          saveBtn +
          '<button class="btn-play-stream" data-idx="' + i + '">\u25B6 Play</button>' +
        '</div>';
      }).join('');

      container.querySelectorAll('.btn-save-lib').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          var r = searchResults[parseInt(btn.dataset.idx)];
          addToLibrary(r.id, r.title, r.thumbnail, r.duration);
          btn.textContent = '\u2713';
          btn.disabled = true;
          toast('Saved to library', 'success');
        });
      });

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
        var saveBtn = currentUser ? '<button class="btn-save-lib" data-idx="' + i + '" title="Save to Library">+</button>' : '';
        return '<div class="search-result-item" data-idx="' + i + '">' +
          thumbImg +
          '<div class="search-result-info">' +
            '<div class="search-result-title">' + escapeHtml(r.title) + '</div>' +
            '<div class="search-result-meta">' + escapeHtml(r.channel) + ' \u00B7 ' + (r.durationStr || '?:??') + '</div>' +
          '</div>' +
          saveBtn +
          '<button class="btn-play-stream" data-idx="' + i + '">\u25B6 Play</button>' +
        '</div>';
      }).join('');

      container.querySelectorAll('.btn-save-lib').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          var r = searchResults[parseInt(btn.dataset.idx)];
          addToLibrary(r.id, r.title, r.thumbnail, r.duration);
          btn.textContent = '\u2713';
          btn.disabled = true;
          toast('Saved to library', 'success');
        });
      });

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

        // Send progress to opponent in competitive mode
        if (compGameMode && currentMatchId && socket) {
          socket.emit('competitive:scoreUpdate', { matchId: currentMatchId, score: score, combo: combo });
        }
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

    // If competitive mode, send results via socket and show waiting screen
    if (compGameMode && currentMatchId && socket) {
      socket.emit('competitive:finish', {
        matchId: currentMatchId,
        results: {
          score: results.score,
          grade: results.grade,
          accuracy: results.accuracy,
          maxCombo: results.combo,
          hits: results.hits,
        },
      });
      showScreen('competitive');
      showCompSection('comp-waiting-finish');
      return;
    }

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

    // Check which songs are in user's library
    var libraryIds = new Set(songs.map(function (s) { return s.videoId; }));

    listEl.innerHTML = entries.map(function (e, i) {
      var videoId = (e.songFilename || '').replace(/\.mp3$/i, '');
      var looksLikeVideoId = /^[a-zA-Z0-9_-]{11}$/.test(videoId);

      var playBtnHtml = looksLikeVideoId
        ? '<button class="lb-play-btn" data-videoid="' + escapeHtml(videoId) + '" data-title="' + escapeHtml(e.songTitle) + '">▶ Play</button>'
        : '';

      var libBtnHtml = '';
      if (currentUser && looksLikeVideoId) {
        if (libraryIds.has(videoId)) {
          libBtnHtml = '<span class="lb-dl-btn downloaded">✓ Saved</span>';
        } else {
          libBtnHtml = '<button class="lb-dl-btn" data-videoid="' + escapeHtml(videoId) + '" data-title="' + escapeHtml(e.songTitle) + '">+ Library</button>';
        }
      }

      return '<div class="lb-song-item" data-key="' + escapeHtml(e.key) + '">' +
        '<div class="lb-rank">' + (i + 1) + '</div>' +
        '<div class="lb-song-info">' +
          '<div class="lb-song-title">' + escapeHtml(e.songTitle) + '</div>' +
          '<div class="lb-song-plays">' + e.plays + ' play' + (e.plays !== 1 ? 's' : '') + '</div>' +
        '</div>' +
        '<div class="lb-song-stats">' +
          '<div class="lb-song-top-score">' + (e.topScore || 0).toLocaleString() + '</div>' +
          '<div class="lb-song-top-grade">Best: ' + (e.topGrade || '-') + ' <span class="lb-score-username lb-username-link" data-username="' + escapeHtml(e.topUser || '') + '">by ' + escapeHtml(e.topUser || 'Guest') + '</span></div>' +
          (e.top3 && e.top3.length > 1 ? '<div class="lb-top3">' + e.top3.map(function (t, ti) {
            return '<span class="lb-top3-entry">' + (ti + 1) + '. ' + escapeHtml(t.username) + ' (' + t.score.toLocaleString() + ')</span>';
          }).join(' ') + '</div>' : '') +
        '</div>' +
        '<div class="lb-song-actions">' + playBtnHtml + libBtnHtml + '</div>' +
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

    // Play from leaderboard via YouTube streaming
    listEl.querySelectorAll('.lb-play-btn').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var videoId = btn.dataset.videoid;
        var title = btn.dataset.title;
        streamAndPlay(videoId, title, null, 0);
      });
    });

    // Save to library from leaderboard
    listEl.querySelectorAll('.lb-dl-btn:not(.downloaded)').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var videoId = btn.dataset.videoid;
        var title = btn.dataset.title;
        addToLibrary(videoId, title, null, 0);
        btn.textContent = '✓ Saved';
        btn.classList.add('downloaded');
        toast('Saved to library', 'success');
      });
    });

    // Click username to view profile
    listEl.querySelectorAll('.lb-username-link').forEach(function (el) {
      el.style.cursor = 'pointer';
      el.addEventListener('click', function (e) {
        e.stopPropagation();
        var username = el.dataset.username;
        if (username && username !== 'Guest') loadProfile(username);
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

      // Show play button — stream via YouTube or from library
      var playBtn = $('#lb-play-song');
      var songFilename = data.songFilename || key;
      var songTitle = data.songTitle || key;
      var matchedSong = songs.find(function (s) { return s.filename === songFilename || s.title === songTitle; });
      // Extract videoId from filename (e.g. "dQw4w9WgXcQ.mp3" → "dQw4w9WgXcQ")
      var videoId = songFilename.replace(/\.mp3$/i, '');
      var looksLikeVideoId = /^[a-zA-Z0-9_-]{11}$/.test(videoId);

      if (matchedSong) {
        playBtn.style.display = '';
        playBtn.textContent = '▶ Play This Song';
        playBtn.onclick = function () {
          selectedSongIdx = songs.indexOf(matchedSong);
          currentSong = matchedSong;
          startGame();
        };
      } else if (looksLikeVideoId) {
        playBtn.style.display = '';
        playBtn.textContent = '▶ Play This Song';
        playBtn.onclick = function () {
          streamAndPlay(videoId, songTitle, null, 0);
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
      connectSocket();
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
      if (socket) { socket.disconnect(); socket = null; }
      compGameMode = false;
      currentMatchId = null;
      showScreen('auth');
    });
  }

  // ═══════════════════════ SOCKET.IO ═══════════════════════

  var socket = null;
  var currentMatchId = null;
  var compGameMode = false;

  function connectSocket() {
    if (socket) return;
    var wsUrl = location.hostname === 'localhost' ? location.origin : 'https://dj-hero-production.up.railway.app';
    socket = io(wsUrl, { transports: ['websocket', 'polling'] });
    socket.on('connect', function () {
      var t = getToken();
      if (t) socket.emit('auth', { token: t });
    });
    socket.on('auth:ok', function () { });

    // Friend notifications
    socket.on('friend:request', function (data) {
      toast(data.from + ' sent you a friend request!', 'info');
    });
    socket.on('friend:accepted', function (data) {
      toast(data.username + ' accepted your friend request!', 'success');
    });

    // Challenge received
    socket.on('challenge:received', function (data) {
      if (confirm(data.from + ' challenges you to a competitive match! Accept?')) {
        socket.emit('challenge:accept', { from: data.from });
      } else {
        socket.emit('challenge:decline', { from: data.from });
      }
    });
    socket.on('challenge:declined', function (data) {
      toast(data.username + ' declined your challenge', 'info');
    });
    socket.on('challenge:sent', function () {
      toast('Challenge sent!', 'success');
    });

    // Competitive events
    socket.on('competitive:matched', function (data) {
      currentMatchId = data.matchId;
      showScreen('competitive');
      showCompSection('comp-song-select');
      $('#comp-opponent-name').textContent = data.opponent;
    });

    socket.on('competitive:songChosen', function (data) {
      showCompSection('comp-ready');
      $('#comp-chosen-song').textContent = data.song.title;
      currentMatchId = data.matchId;
      compChosenSong = data.song;
    });

    socket.on('competitive:start', function (data) {
      compGameMode = true;
      streamAndPlay(compChosenSong.videoId, compChosenSong.title, compChosenSong.thumbnail || null, compChosenSong.duration || 0);
    });

    socket.on('competitive:opponentProgress', function (data) {
      var el = $('#comp-opponent-live');
      if (el) el.innerHTML = 'Opponent: <span>' + (data.score || 0).toLocaleString() + '</span> pts';
    });

    socket.on('competitive:opponentFinished', function () {
      // Opponent is done, we might still be playing
    });

    socket.on('competitive:results', function (data) {
      compGameMode = false;
      showScreen('competitive');
      showCompResults(data);
    });
  }

  var compChosenSong = null;

  function showCompSection(sectionId) {
    var sections = ['comp-queue', 'comp-song-select', 'comp-ready', 'comp-results', 'comp-waiting-finish'];
    sections.forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.classList.toggle('hidden', id !== sectionId);
    });
  }

  function showCompResults(data) {
    showCompSection('comp-results');
    var isP1 = data.player1.username === (currentUser && currentUser.username);
    var me = isP1 ? data.player1 : data.player2;
    var them = isP1 ? data.player2 : data.player1;

    var titleEl = $('#comp-results-title');
    if (data.draw) {
      titleEl.textContent = 'DRAW!';
      titleEl.className = 'comp-results-title draw';
    } else if (data.winner === me.username) {
      titleEl.textContent = 'VICTORY!';
      titleEl.className = 'comp-results-title win';
    } else {
      titleEl.textContent = 'DEFEAT';
      titleEl.className = 'comp-results-title lose';
    }

    var gradeColors = { S: '#ffea00', A: '#00e5ff', B: '#00ff88', C: '#ff9800', D: '#ff5722', F: '#ff3d5a' };

    // Left column = me
    $('#comp-p1-name').textContent = me.username;
    $('#comp-p1-score').textContent = (me.score || 0).toLocaleString();
    $('#comp-p1-grade').textContent = me.grade || '-';
    $('#comp-p1-grade').style.color = gradeColors[me.grade] || '#00e5ff';
    $('#comp-p1-stats').innerHTML = (me.accuracy || 0) + '% accuracy<br>' + (me.maxCombo || 0) + ' max combo';

    $('#comp-p2-name').textContent = them.username;
    $('#comp-p2-score').textContent = (them.score || 0).toLocaleString();
    $('#comp-p2-grade').textContent = them.grade || '-';
    $('#comp-p2-grade').style.color = gradeColors[them.grade] || '#00e5ff';
    $('#comp-p2-stats').innerHTML = (them.accuracy || 0) + '% accuracy<br>' + (them.maxCombo || 0) + ' max combo';

    // Winner highlight
    var cols = document.querySelectorAll('.comp-result-col');
    cols.forEach(function (c) { c.classList.remove('winner'); });
    if (data.winner === me.username) cols[0].classList.add('winner');
    else if (data.winner === them.username) cols[1].classList.add('winner');

    var mmrEl = $('#comp-mmr-change');
    if (data.mmrChange && !data.draw) {
      var isWinner = data.winner === me.username;
      var change = isWinner ? data.mmrChange.winner : data.mmrChange.loser;
      var cls = change >= 0 ? 'mmr-gain' : 'mmr-loss';
      var sign = change >= 0 ? '+' : '';
      mmrEl.innerHTML = 'MMR: <span class="' + cls + '">' + sign + change + '</span>';
    } else {
      mmrEl.innerHTML = 'MMR: unchanged';
    }

    currentMatchId = null;
  }

  async function loadRankings() {
    try {
      var res = await fetch('/api/rankings');
      var rankings = await res.json();
      var el = $('#comp-rankings');
      if (rankings.length === 0) {
        el.innerHTML = '<p class="empty-msg">No ranked players yet</p>';
        return;
      }
      el.innerHTML = rankings.map(function (r, i) {
        return '<div class="comp-rank-item" data-username="' + escapeHtml(r.username) + '">' +
          '<div class="comp-rank-pos">#' + (i + 1) + '</div>' +
          '<div class="comp-rank-name">' + escapeHtml(r.username) + '</div>' +
          '<div class="comp-rank-mmr">' + r.mmr + ' MMR</div>' +
        '</div>';
      }).join('');
      el.querySelectorAll('.comp-rank-item').forEach(function (item) {
        item.addEventListener('click', function () {
          loadProfile(item.dataset.username);
        });
      });
    } catch (e) {}

    // Load own MMR
    if (currentUser) {
      try {
        var res2 = await fetch('/api/profile/' + encodeURIComponent(currentUser.username), { headers: authHeaders() });
        var p = await res2.json();
        $('#comp-my-mmr').textContent = p.mmr || 1000;
      } catch (e) {}
    }
  }

  // ═══════════════════════ PROFILE ═══════════════════════

  async function loadProfile(username) {
    showScreen('profile');
    $('#profile-username').textContent = username;
    $('#profile-scores').innerHTML = '<div class="spinner"></div>';
    $('#profile-actions').innerHTML = '';

    try {
      var res = await fetch('/api/profile/' + encodeURIComponent(username), { headers: authHeaders() });
      if (!res.ok) { toast('User not found', 'error'); showScreen('library'); return; }
      var data = await res.json();

      $('#profile-username').textContent = data.username;
      $('#profile-mmr').textContent = 'MMR: ' + (data.mmr || 1000);
      var onlineEl = $('#profile-online');
      onlineEl.textContent = data.online ? 'Online' : 'Offline';
      onlineEl.className = 'profile-online-badge ' + (data.online ? 'online' : 'offline');

      // Actions
      var actionsHtml = '';
      if (data.friendStatus === 'none') {
        actionsHtml += '<button class="btn-primary btn-sm" id="profile-add-friend">Add Friend</button>';
      } else if (data.friendStatus === 'pending_sent') {
        actionsHtml += '<span class="btn-sm" style="color:var(--text-dim)">Request Sent</span>';
      } else if (data.friendStatus === 'pending_received') {
        actionsHtml += '<button class="btn-primary btn-sm" id="profile-accept-friend">Accept Request</button>';
      } else if (data.friendStatus === 'friends') {
        actionsHtml += '<span class="btn-sm" style="color:var(--green)">✓ Friends</span>';
        if (data.online) {
          actionsHtml += '<button class="btn-primary btn-sm" id="profile-challenge">⚔️ Challenge</button>';
        }
      }
      $('#profile-actions').innerHTML = actionsHtml;

      if (document.getElementById('profile-add-friend')) {
        document.getElementById('profile-add-friend').addEventListener('click', async function () {
          await fetch('/api/friends/add', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ username: data.username }) });
          this.textContent = 'Sent!';
          this.disabled = true;
        });
      }
      if (document.getElementById('profile-accept-friend')) {
        document.getElementById('profile-accept-friend').addEventListener('click', async function () {
          await fetch('/api/friends/accept', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ username: data.username }) });
          this.textContent = '✓ Friends';
          this.disabled = true;
        });
      }
      if (document.getElementById('profile-challenge')) {
        document.getElementById('profile-challenge').addEventListener('click', function () {
          if (socket) socket.emit('challenge:send', { username: data.username });
        });
      }

      // Scores
      var gradeColors = { S: '#ffea00', A: '#00e5ff', B: '#00ff88', C: '#ff9800', D: '#ff5722', F: '#ff3d5a' };
      var scoresEl = $('#profile-scores');
      if (!data.scores || data.scores.length === 0) {
        scoresEl.innerHTML = '<p class="empty-msg">No songs played yet</p>';
        return;
      }

      var libraryIds = new Set(songs.map(function (s) { return s.videoId; }));

      scoresEl.innerHTML = data.scores.map(function (s, i) {
        var videoId = (s.songFilename || '').replace(/\.mp3$/i, '');
        var looksLikeVideoId = /^[a-zA-Z0-9_-]{11}$/.test(videoId);
        var playBtn = looksLikeVideoId
          ? '<button class="btn-play-lib profile-play-btn" data-videoid="' + escapeHtml(videoId) + '" data-title="' + escapeHtml(s.songTitle) + '">▶</button>'
          : '';
        var saveBtn = '';
        if (currentUser && looksLikeVideoId && !libraryIds.has(videoId)) {
          saveBtn = '<button class="btn-save-lib profile-save-btn" data-videoid="' + escapeHtml(videoId) + '" data-title="' + escapeHtml(s.songTitle) + '">+</button>';
        }
        return '<div class="profile-score-item">' +
          '<div class="profile-score-grade" style="color:' + (gradeColors[s.grade] || '#00e5ff') + '">' + (s.grade || '-') + '</div>' +
          '<div class="profile-score-info">' +
            '<div class="profile-score-title">' + escapeHtml(s.songTitle) + '</div>' +
            '<div class="profile-score-meta">' + (s.accuracy || 0) + '% · ' + (s.maxCombo || 0) + ' combo · ' + (s.difficulty || '?') + '</div>' +
          '</div>' +
          '<div class="profile-score-value">' + (s.score || 0).toLocaleString() + '</div>' +
          playBtn + saveBtn +
        '</div>';
      }).join('');

      scoresEl.querySelectorAll('.profile-play-btn').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          streamAndPlay(btn.dataset.videoid, btn.dataset.title, null, 0);
        });
      });
      scoresEl.querySelectorAll('.profile-save-btn').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          addToLibrary(btn.dataset.videoid, btn.dataset.title, null, 0);
          btn.textContent = '✓';
          btn.disabled = true;
          toast('Saved to library', 'success');
        });
      });
    } catch (e) {
      $('#profile-scores').innerHTML = '<p class="empty-msg">Failed to load profile</p>';
    }
  }

  // ═══════════════════════ FRIENDS ═══════════════════════

  async function loadFriends() {
    try {
      var res = await fetch('/api/friends', { headers: authHeaders() });
      var data = await res.json();

      // Incoming requests
      var reqEl = $('#friend-requests');
      if (data.incoming && data.incoming.length > 0) {
        reqEl.innerHTML = '<h3>Friend Requests</h3>' + data.incoming.map(function (r) {
          return '<div class="friend-request-item">' +
            '<span class="fr-name">' + escapeHtml(r.username) + '</span>' +
            '<div class="fr-actions">' +
              '<button class="btn-primary btn-sm fr-accept" data-username="' + escapeHtml(r.username) + '">Accept</button>' +
              '<button class="btn-secondary btn-sm fr-decline" data-username="' + escapeHtml(r.username) + '">Decline</button>' +
            '</div>' +
          '</div>';
        }).join('');

        reqEl.querySelectorAll('.fr-accept').forEach(function (btn) {
          btn.addEventListener('click', async function () {
            await fetch('/api/friends/accept', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ username: btn.dataset.username }) });
            loadFriends();
          });
        });
        reqEl.querySelectorAll('.fr-decline').forEach(function (btn) {
          btn.addEventListener('click', async function () {
            await fetch('/api/friends/decline', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ username: btn.dataset.username }) });
            loadFriends();
          });
        });
      } else {
        reqEl.innerHTML = '';
      }

      // Friends list
      var listEl = $('#friends-list');
      if (!data.friends || data.friends.length === 0) {
        listEl.innerHTML = '<p class="empty-msg">No friends yet — add someone by username above!</p>';
        return;
      }
      listEl.innerHTML = data.friends.map(function (f) {
        return '<div class="friend-item">' +
          '<span class="friend-name">' + escapeHtml(f.username) + '</span>' +
          '<span class="friend-status ' + (f.online ? 'online' : 'offline') + '">' + (f.online ? 'Online' : 'Offline') + '</span>' +
          '<div class="friend-actions">' +
            '<button class="btn-secondary btn-sm friend-view" data-username="' + escapeHtml(f.username) + '">Profile</button>' +
            (f.online ? '<button class="btn-primary btn-sm friend-challenge" data-username="' + escapeHtml(f.username) + '">⚔️</button>' : '') +
            '<button class="btn-secondary btn-sm friend-remove" data-username="' + escapeHtml(f.username) + '" style="color:var(--red)">✕</button>' +
          '</div>' +
        '</div>';
      }).join('');

      listEl.querySelectorAll('.friend-view').forEach(function (btn) {
        btn.addEventListener('click', function () { loadProfile(btn.dataset.username); });
      });
      listEl.querySelectorAll('.friend-challenge').forEach(function (btn) {
        btn.addEventListener('click', function () {
          if (socket) socket.emit('challenge:send', { username: btn.dataset.username });
        });
      });
      listEl.querySelectorAll('.friend-remove').forEach(function (btn) {
        btn.addEventListener('click', async function () {
          await fetch('/api/friends/' + encodeURIComponent(btn.dataset.username), { method: 'DELETE', headers: authHeaders() });
          loadFriends();
        });
      });
    } catch (e) {
      $('#friends-list').innerHTML = '<p class="empty-msg">Failed to load friends</p>';
    }
  }

  // ═══════════════════════ EVENT WIRING ═══════════════════════

  function init() {
    // Setup auth
    setupAuthHandlers();

    // Try auto-login, then restore screen from URL hash
    tryAutoLogin().then(function (loggedIn) {
      if (loggedIn) {
        enterApp(currentUser);
        // After enterApp sets up library, navigate to hash if present
        navigateToHash();
      } else if (location.hash === '#auth' || !location.hash) {
        showScreen('auth');
      } else {
        // Not logged in but hash present — show auth
        showScreen('auth');
      }
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

    // ─── Profile ───
    $('#btn-go-profile').addEventListener('click', function () {
      if (currentUser) loadProfile(currentUser.username);
      else toast('Log in to view your profile', 'error');
    });
    $('#btn-back-from-profile').addEventListener('click', function () {
      showScreen('library');
    });

    // ─── Friends ───
    $('#btn-go-friends').addEventListener('click', function () {
      if (!currentUser) { toast('Log in to manage friends', 'error'); return; }
      showScreen('friends');
      loadFriends();
    });
    $('#btn-back-from-friends').addEventListener('click', function () {
      showScreen('library');
    });
    $('#friend-add-btn').addEventListener('click', async function () {
      var username = $('#friend-add-input').value.trim();
      if (!username) return;
      try {
        var res = await fetch('/api/friends/add', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ username: username }) });
        var data = await res.json();
        var resultEl = $('#friend-add-result');
        if (data.status === 'sent') {
          resultEl.innerHTML = '<span style="color:var(--green)">Friend request sent!</span>';
          $('#friend-add-input').value = '';
          loadFriends();
        } else if (data.status === 'already_friends') {
          resultEl.innerHTML = '<span style="color:var(--text-dim)">Already friends!</span>';
        } else if (data.status === 'already_pending') {
          resultEl.innerHTML = '<span style="color:var(--text-dim)">Request already pending</span>';
        } else if (data.error) {
          resultEl.innerHTML = '<span style="color:var(--red)">' + escapeHtml(data.error) + '</span>';
        }
      } catch (e) {
        $('#friend-add-result').innerHTML = '<span style="color:var(--red)">Failed to send request</span>';
      }
    });

    // ─── Competitive ───
    $('#btn-go-competitive').addEventListener('click', function () {
      if (!currentUser) { toast('Log in to play competitive', 'error'); return; }
      showScreen('competitive');
      showCompSection('comp-queue');
      loadRankings();
    });
    $('#btn-back-from-comp').addEventListener('click', function () {
      if (socket) socket.emit('competitive:dequeue');
      showScreen('library');
    });
    $('#comp-find-match').addEventListener('click', function () {
      if (!socket) { toast('Not connected', 'error'); return; }
      socket.emit('competitive:queue');
      $('#comp-find-match').classList.add('hidden');
      $('#comp-queue-status').classList.remove('hidden');
    });
    $('#comp-cancel-queue').addEventListener('click', function () {
      if (socket) socket.emit('competitive:dequeue');
      $('#comp-find-match').classList.remove('hidden');
      $('#comp-queue-status').classList.add('hidden');
    });
    $('#comp-song-search-btn').addEventListener('click', function () {
      var q = $('#comp-song-search').value.trim();
      if (q) compSearchSong(q);
    });
    $('#comp-song-search').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        var q = e.target.value.trim();
        if (q) compSearchSong(q);
      }
    });
    $('#comp-ready-btn').addEventListener('click', function () {
      if (socket && currentMatchId) {
        socket.emit('competitive:ready', { matchId: currentMatchId });
        $('#comp-ready-btn').classList.add('hidden');
        $('#comp-ready-waiting').classList.remove('hidden');
      }
    });
    $('#comp-back-to-queue').addEventListener('click', function () {
      showCompSection('comp-queue');
      $('#comp-find-match').classList.remove('hidden');
      $('#comp-queue-status').classList.add('hidden');
      loadRankings();
    });
  }

  // ─── Competitive song search ──────────────────────
  async function compSearchSong(query) {
    var container = $('#comp-song-results');
    container.innerHTML = '<p class="empty-msg">Searching...</p>';
    try {
      var res = await fetch('/api/search?q=' + encodeURIComponent(query));
      if (!res.ok) throw new Error('Search failed');
      var results = await res.json();
      if (results.length === 0) {
        container.innerHTML = '<p class="empty-msg">No results</p>';
        return;
      }
      container.innerHTML = results.map(function (r, i) {
        return '<div class="search-result-item comp-song-pick" data-idx="' + i + '">' +
          (r.thumbnail ? '<img src="' + escapeHtml(r.thumbnail) + '" alt="" loading="lazy">' : '') +
          '<div class="search-result-info">' +
            '<div class="search-result-title">' + escapeHtml(r.title) + '</div>' +
            '<div class="search-result-meta">' + escapeHtml(r.channel) + ' · ' + (r.durationStr || '?:??') + '</div>' +
          '</div>' +
          '<button class="btn-primary btn-sm">Pick</button>' +
        '</div>';
      }).join('');
      container.querySelectorAll('.comp-song-pick button').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var idx = parseInt(btn.closest('.comp-song-pick').dataset.idx);
          var r = results[idx];
          if (socket && currentMatchId) {
            socket.emit('competitive:selectSong', {
              matchId: currentMatchId,
              song: { videoId: r.id, title: r.title, thumbnail: r.thumbnail, duration: r.duration },
            });
            container.innerHTML = '<p class="empty-msg">Song picked! Waiting for opponent...</p>';
            $('#comp-song-waiting').classList.remove('hidden');
          }
        });
      });
    } catch (e) {
      container.innerHTML = '<p class="empty-msg">Search failed</p>';
    }
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
