(function () {
  'use strict';
  var testId = location.pathname.split('/')[2];
  var data = null;

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : s;
    return d.innerHTML;
  }
  function fmtMs(ms) {
    if (ms == null) return '—';
    if (ms < 1000) return (ms / 1000).toFixed(1) + 's';
    var s = Math.round(ms / 1000);
    return s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + (s % 60) + 's';
  }

  function stat(k, v, title) {
    return '<div class="stat"' + (title ? ' title="' + esc(title) + '"' : '') + '><div class="v">' + v + '</div><div class="k">' + k + '</div></div>';
  }

  function bars(target, values, labels, titles) {
    var max = Math.max.apply(null, values.concat([1]));
    var host = $(target);
    host.innerHTML = '';
    values.forEach(function (v, i) {
      var bar = document.createElement('div');
      bar.className = 'bar';
      if (titles && titles[i]) bar.title = titles[i];
      bar.innerHTML =
        '<div class="num">' + (v || '') + '</div>' +
        '<div class="fill" style="height:' + Math.round((v / max) * 100) + '%"></div>' +
        '<div class="lbl">' + labels[i] + '</div>';
      host.appendChild(bar);
    });
  }

  function renderFunnel(m) {
    var eligible = m.started - m.discarded;
    var stages = [
      ['Started', m.started],
      ['Completed', m.completed],
      ['Succeeded', m.succeeded],
    ];
    var max = Math.max(m.started, 1);
    $('funnel').innerHTML = stages.map(function (s) {
      return '<div class="frow"><div class="fname">' + s[0] + '</div>' +
        '<div class="ftrack"><div class="fbar" style="width:' + Math.round((s[1] / max) * 100) + '%"></div></div>' +
        '<div class="fval">' + s[1] + '</div></div>';
    }).join('');
    var notes = [];
    if (m.discarded) notes.push(m.discarded + ' junk session' + (m.discarded > 1 ? 's' : '') + ' auto-discarded (bots / instant quits)');
    if (m.abandoned) notes.push(m.abandoned + ' left without finishing');
    if (m.gaveUp) notes.push(m.gaveUp + ' gave up');
    $('discardnote').textContent = notes.join(' · ');
    void eligible;
  }

  // Per-step progress through the success-signal chain (only interesting for
  // chains longer than one — a single step duplicates "Succeeded").
  function renderChainFunnel(m) {
    var sigs = m.signals || [];
    if (sigs.length < 2) return;
    $('chainfunnel').style.display = '';
    var max = Math.max(m.started - m.discarded, 1);
    $('chainrows').innerHTML = sigs.map(function (s, i) {
      var name = (i + 1) + '. ' + (s.label || '');
      return '<div class="frow"><div class="fname" title="' + esc(name) + '">' + esc(name) + '</div>' +
        '<div class="ftrack"><div class="fbar" style="width:' + Math.round((s.hit / max) * 100) + '%"></div></div>' +
        '<div class="fval">' + s.hit + '</div></div>';
    }).join('');
  }

  function renderTimes(times) {
    var host = $('timechart');
    if (!times.length) { host.innerHTML = '<p class="muted">No successful sessions yet.</p>'; return; }
    var maxT = Math.max.apply(null, times);
    var bucketMs = Math.max(5000, Math.ceil(maxT / 6 / 5000) * 5000);
    var n = Math.min(8, Math.max(3, Math.ceil(maxT / bucketMs) + 1));
    var counts = new Array(n).fill(0);
    times.forEach(function (t) { counts[Math.min(n - 1, Math.floor(t / bucketMs))]++; });
    var labels = counts.map(function (_, i) { return '≤' + Math.round(((i + 1) * bucketMs) / 1000) + 's'; });
    bars('timechart', counts, labels, labels.map(function (l, i) { return counts[i] + ' session(s) ' + l; }));
  }

  // ---------- free-text feedback (SEQ comments + post-test notes) ----------

  var SENT_LABELS = ['negative', 'neutral', 'positive'];

  function sentBadge(label) {
    return label ? '<span class="badge ' + label + '">' + label + '</span>' : '';
  }

  // A distribution bar over the scored feedback, then the counts under it.
  function sentRollup(items) {
    var counts = { negative: 0, neutral: 0, positive: 0 };
    var scored = 0;
    items.forEach(function (i) {
      if (i.sentimentLabel) { counts[i.sentimentLabel]++; scored++; }
    });
    if (!scored) return '';
    var segs = SENT_LABELS.filter(function (l) { return counts[l]; }).map(function (l) {
      return '<span class="seg-' + l + '" style="width:' + (counts[l] / scored * 100) + '%"></span>';
    }).join('');
    var legend = SENT_LABELS.map(function (l) { return counts[l] + ' ' + l; }).join(' · ');
    return '<div class="sentbar">' + segs + '</div>' +
      '<p class="muted sentlegend">' + legend + '</p>';
  }

  // Comments and notes render identically apart from the byline, so one
  // renderer drives both cards — and re-runs on filter/sort without refetching.
  function renderFeedback(cfg) {
    var items = data[cfg.key];
    $(cfg.ctl).style.display = items.length ? '' : 'none';
    $(cfg.roll).innerHTML = sentRollup(items);

    var want = $(cfg.filter).value;
    var shown = want === 'all' ? items.slice() : items.filter(function (i) {
      return i.sentimentLabel === want;
    });

    var order = $(cfg.sort).value;
    if (order !== 'received') {
      var dir = order === 'negfirst' ? 1 : -1;
      // Unscored comments hold no opinion — park them at the end either way.
      shown.sort(function (a, b) {
        if (a.sentiment == null) return b.sentiment == null ? 0 : 1;
        if (b.sentiment == null) return -1;
        return (a.sentiment - b.sentiment) * dir;
      });
    }

    if (!shown.length) {
      $(cfg.host).innerHTML = '<p class="muted">' +
        (items.length ? 'No ' + want + ' ' + cfg.noun + '.' : 'No ' + cfg.noun + ' yet.') +
        '</p>';
      return;
    }
    $(cfg.host).innerHTML = shown.map(function (i) {
      return '<div class="comment' + (i.sentimentLabel ? ' ' + i.sentimentLabel : '') + '">' +
        '“' + esc(cfg.text(i)) + '”' +
        '<div class="who">' + sentBadge(i.sentimentLabel) +
        '<span>' + cfg.byline(i) + '</span></div></div>';
    }).join('');
  }

  var COMMENTS = {
    key: 'comments', host: 'comments', ctl: 'commentctl', roll: 'commentroll',
    filter: 'commentfilter', sort: 'commentsort', noun: 'comments',
    text: function (c) { return c.comment; },
    byline: function (c) {
      return 'SEQ ' + (c.score || '—') + '/7 · session ' + esc(c.sessionId.slice(0, 6));
    },
  };
  var NOTES = {
    key: 'notes', host: 'notes', ctl: 'notectl', roll: 'noteroll',
    filter: 'notefilter', sort: 'notesort', noun: 'notes',
    text: function (n) { return n.note; },
    byline: function (n) { return 'session ' + esc(n.sessionId.slice(0, 6)); },
  };

  function render() {
    var m = data.metrics;
    var t = data.test;
    $('crumb').textContent = t.name + ' · ' + t.status;
    $('setuplink').href = '/tests/' + testId + '/setup';
    $('exportcsv').href = '/api/tests/' + testId + '/export.csv';
    $('exportjson').href = '/api/tests/' + testId + '/export.json';
    document.title = t.name + ' — results';

    $('metrics').innerHTML =
      stat('Responses', m.completed + ' <span class="muted" style="font-size:14px">/ ' + t.response_cap + '</span>') +
      stat('Success rate', m.successRate == null ? '—' : Math.round(m.successRate * 100) + '%',
        'Auto-detected: ' + (t.signals || []).map(function (s) {
          return s.label || s.selector || s.screen || '';
        }).join(' → ')) +
      stat('Median time', fmtMs(m.medianTimeMs)) +
      stat('Avg ease (SEQ)', m.seqAvg == null ? '—' : m.seqAvg.toFixed(1) + ' <span class="muted" style="font-size:14px">/ 7</span>');

    renderFunnel(m);
    renderChainFunnel(m);
    renderTimes(m.times);
    bars('seqchart', m.seqDist, ['1', '2', '3', '4', '5', '6', '7'],
      m.seqDist.map(function (v, i) { return v + ' rated ' + (i + 1); }));

    // Comments
    if (data.comments.length) renderFeedback(COMMENTS);
    $('commentfilter').onchange = function () { renderFeedback(COMMENTS); };
    $('commentsort').onchange = function () { renderFeedback(COMMENTS); };

    // Post-test notes
    if (data.notes.length) {
      $('notescard').style.display = '';
      renderFeedback(NOTES);
    }
    $('notefilter').onchange = function () { renderFeedback(NOTES); };
    $('notesort').onchange = function () { renderFeedback(NOTES); };

    // Sessions table
    var tbody = document.querySelector('#sessions tbody');
    tbody.innerHTML = '';
    data.sessions.forEach(function (s) {
      var outcome;
      if (s.status === 'discarded') outcome = '<span class="muted">discarded (' + esc(s.discardReason || '') + ')</span>';
      else if (s.status === 'started') outcome = '<span class="muted">did not finish</span>';
      else if (s.success) outcome = '<span class="ok">✓ success</span>';
      else outcome = '<span class="bad">✗ ' + (s.gaveUp ? 'gave up' : 'failed') + '</span>';
      var tr = document.createElement('tr');
      tr.innerHTML =
        '<td class="muted">' + new Date(s.startedAt).toLocaleString() + '</td>' +
        '<td>' + outcome + '</td>' +
        '<td>' + fmtMs(s.durationMs) + '</td>' +
        '<td>' + (s.seqScore || '—') + '</td>' +
        '<td>' + esc(s.screenerAnswer || '—') + '</td>' +
        '<td>' + s.interactionCount + '</td>' +
        '<td><button class="btn-sm" data-replay="' + s.id + '">Replay</button></td>';
      tbody.appendChild(tr);
    });
    tbody.addEventListener('click', function (e) {
      var sid = e.target.dataset && e.target.dataset.replay;
      if (sid) openReplay(sid);
    });
  }

  // ---------- replay (thin UI over rrweb.Replayer) ----------
  var replayer = null;
  var progressTimer = null;
  var playing = false;
  var totalTime = 0;

  function fitPlayer(recW, recH) {
    var maxW = Math.min(920, window.innerWidth - 120);
    var maxH = Math.min(520, window.innerHeight - 260);
    var scale = Math.min(maxW / recW, maxH / recH, 1);
    var view = $('playerview');
    view.style.width = Math.round(recW * scale) + 'px';
    view.style.height = Math.round(recH * scale) + 'px';
    var wrapper = view.querySelector('.replayer-wrapper');
    if (wrapper) wrapper.style.transform = 'scale(' + scale + ')';
  }

  function openReplay(sid) {
    fetch('/api/tests/' + testId + '/sessions/' + sid + '/events')
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j.events || j.events.length < 2) { alert('No replay data for this session.'); return; }
        $('replaymodal').style.display = 'flex';
        $('playerview').innerHTML = '';
        replayer = new rrweb.Replayer(j.events, {
          root: $('playerview'),
          mouseTail: { strokeStyle: '#c2410c' },
          speed: 1,
        });
        var meta = j.events.find(function (e) { return e.type === 4; });
        fitPlayer(meta ? meta.data.width : 1280, meta ? meta.data.height : 800);
        totalTime = replayer.getMetaData().totalTime;
        replayer.play();
        playing = true;
        $('playpause').textContent = 'Pause';
        clearInterval(progressTimer);
        progressTimer = setInterval(function () {
          if (!replayer) return;
          var cur = Math.min(replayer.getCurrentTime(), totalTime);
          $('progressfill').style.width = totalTime ? (cur / totalTime) * 100 + '%' : '0';
          $('playertime').textContent = fmtMs(cur) + ' / ' + fmtMs(totalTime);
          if (cur >= totalTime && playing) {
            playing = false;
            $('playpause').textContent = 'Replay';
          }
        }, 150);
      });
  }

  $('playpause').onclick = function () {
    if (!replayer) return;
    var cur = replayer.getCurrentTime();
    if (playing) {
      replayer.pause();
      playing = false;
      this.textContent = 'Play';
    } else {
      replayer.play(cur >= totalTime ? 0 : cur);
      playing = true;
      this.textContent = 'Pause';
    }
  };
  $('progresstrack').onclick = function (e) {
    if (!replayer) return;
    var rect = this.getBoundingClientRect();
    var frac = (e.clientX - rect.left) / rect.width;
    replayer.play(frac * totalTime);
    playing = true;
    $('playpause').textContent = 'Pause';
  };
  document.querySelectorAll('.speed').forEach(function (b) {
    b.onclick = function () {
      if (!replayer) return;
      document.querySelectorAll('.speed').forEach(function (x) { x.classList.remove('sel'); });
      b.classList.add('sel');
      replayer.setConfig({ speed: Number(b.dataset.speed) });
    };
  });
  $('closereplay').onclick = function () {
    $('replaymodal').style.display = 'none';
    clearInterval(progressTimer);
    if (replayer) {
      try { replayer.pause(); } catch (e) { /* noop */ }
      $('playerview').innerHTML = '';
      replayer = null;
    }
  };

  // ---------- heatmap ----------
  // The background is a paused rrweb snapshot from a real session — the DOM a
  // tester actually saw on that screen. A live iframe can't render DOM-state
  // screens ("index.html::Checkout") or auth-gated pages at all.
  var heatEventsCache = {}; // sessionId -> events promise
  var bgReplayer = null;
  var bgKey = null;

  function heatEvents(sid) {
    if (!heatEventsCache[sid]) {
      heatEventsCache[sid] = fetch('/api/tests/' + testId + '/sessions/' + sid + '/events')
        .then(function (r) { return r.json(); })
        .then(function (j) { return j.events || []; });
    }
    return heatEventsCache[sid];
  }

  function clearStage() {
    var stage = $('heatstage');
    if (bgReplayer) {
      try { bgReplayer.pause(); } catch (e) { /* noop */ }
      bgReplayer = null;
    }
    Array.prototype.slice.call(stage.children).forEach(function (c) {
      if (c.id !== 'heatempty') stage.removeChild(c);
    });
  }

  function renderSnapshot(snapshot) {
    var stage = $('heatstage');
    if (!snapshot) {
      clearStage();
      bgKey = null;
      $('heatempty').style.display = 'block';
      return Promise.resolve();
    }
    var key = snapshot.sessionId + ':' + snapshot.at;
    if (key === bgKey) return Promise.resolve(); // kind switch — background unchanged
    return heatEvents(snapshot.sessionId).then(function (events) {
      if (events.length < 2) {
        clearStage();
        bgKey = null;
        $('heatempty').style.display = 'block';
        return;
      }
      clearStage();
      $('heatempty').style.display = 'none';
      bgKey = key;
      bgReplayer = new rrweb.Replayer(events, { root: stage, mouseTail: false });
      var meta = events.find(function (e) { return e.type === 4; });
      var recW = meta ? meta.data.width : 1280;
      var recH = meta ? meta.data.height : 800;
      var scale = stage.clientWidth / recW;
      var wrapper = stage.querySelector('.replayer-wrapper');
      if (wrapper) wrapper.style.transform = 'scale(' + scale + ')';
      stage.style.height = Math.min(560, Math.round(recH * scale)) + 'px';
      var total = bgReplayer.getMetaData().totalTime;
      var offset = Math.max(0, Math.min(snapshot.at - events[0].timestamp, total));
      bgReplayer.pause(offset);
    });
  }

  function loadHeatmap() {
    var page = $('heatpage').value;
    var kind = $('heatkind').value;
    if (!page && page !== '') return;
    fetch('/api/tests/' + testId + '/heatmap?kind=' + kind + '&page=' + encodeURIComponent(page))
      .then(function (r) { return r.json(); })
      .then(function (j) {
        renderSnapshot(j.snapshot).then(function () { drawHeatmap(j.points, kind); });
      });
  }

  function drawHeatmap(points, kind) {
    var canvas = $('heatcanvas');
    var wrap = $('heatwrap');
    canvas.width = wrap.clientWidth;
    canvas.height = wrap.clientHeight;
    var ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!points.length) return;

    if (kind === 'scroll') {
      // Average max scroll depth as a fold line over the page.
      var avgRatio = points.reduce(function (a, p) { return a + (p.dh ? p.y / p.dh : 1); }, 0) / points.length;
      var y = Math.min(canvas.height - 2, avgRatio * canvas.height);
      ctx.fillStyle = 'rgba(220,38,38,.85)';
      ctx.fillRect(0, y - 1, canvas.width, 2);
      ctx.font = '12px sans-serif';
      ctx.fillText(Math.round(avgRatio * 100) + '% of testers scrolled this far (page-relative)', 8, y - 6);
      return;
    }

    points.forEach(function (p) {
      if (!p.vw) return;
      var scale = canvas.width / p.vw;
      var x = p.x * scale;
      var y = p.y * scale;
      var r = kind === 'click' ? 14 : 22;
      var a = kind === 'click' ? 0.30 : 0.05;
      var g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, 'rgba(239,68,68,' + a + ')');
      g.addColorStop(1, 'rgba(239,68,68,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  $('heatkind').onchange = loadHeatmap;
  $('heatpage').onchange = loadHeatmap;

  function initHeatmap() {
    var entry = data.test.entry_path || '';
    fetch('/api/tests/' + testId + '/heatmap?kind=click&page=' + encodeURIComponent(entry))
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var pages = j.pages.length ? j.pages : [{ key: entry, count: 0 }];
        var hasEntry = pages.some(function (p) { return p.key === entry; });
        var sel = $('heatpage');
        sel.innerHTML = '';
        pages.forEach(function (p, i) {
          var label = (p.key.replace('::', ' · ') || '(entry)') + (p.count ? ' (' + p.count + ')' : '');
          sel.appendChild(new Option(label, p.key, false, hasEntry ? p.key === entry : i === 0));
        });
        if (hasEntry || !j.pages.length) {
          // The initial fetch already answered for the selected screen.
          renderSnapshot(j.snapshot).then(function () { drawHeatmap(j.points, 'click'); });
        } else {
          loadHeatmap();
        }
      });
  }

  fetch('/api/tests/' + testId + '/results')
    .then(function (r) { return r.json(); })
    .then(function (j) {
      data = j;
      render();
      initHeatmap();
    });
})();
