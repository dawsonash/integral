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
    if (data.comments.length) {
      $('comments').innerHTML = data.comments.map(function (c) {
        return '<div class="comment">“' + esc(c.comment) + '”<div class="who">SEQ ' + (c.score || '—') + '/7 · session ' + c.sessionId.slice(0, 6) + '</div></div>';
      }).join('');
    }

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
          mouseTail: { strokeStyle: '#5a5bd6' },
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
  function loadHeatmap() {
    var page = $('heatpage').value;
    var kind = $('heatkind').value;
    if (!page && page !== '') return;
    $('heatframe').src = '/t/' + testId + '/view/' + page;
    fetch('/api/tests/' + testId + '/heatmap?kind=' + kind + '&page=' + encodeURIComponent(page))
      .then(function (r) { return r.json(); })
      .then(function (j) { drawHeatmap(j.points, kind); });
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
    fetch('/api/tests/' + testId + '/heatmap?kind=click&page=' + encodeURIComponent(data.test.entry_path || ''))
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var pages = j.pages.length ? j.pages : [data.test.entry_path];
        var sel = $('heatpage');
        sel.innerHTML = '';
        pages.forEach(function (p) {
          sel.appendChild(new Option(p || '(entry)', p, false, p === data.test.entry_path));
        });
        loadHeatmap();
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
