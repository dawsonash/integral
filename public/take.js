// Testee shell: consent gate → optional screener → task (recorded iframe) →
// auto-detected success → optional SEQ → thanks. Owns the session and all
// server communication; the injected recorder streams to us via postMessage.
(function () {
  'use strict';
  var testId = location.pathname.split('/')[2];
  var api = '/api/take/' + testId;

  var gate = document.getElementById('gate');
  var gatecard = document.getElementById('gatecard');
  var taskbar = document.getElementById('taskbar');
  var stage = document.getElementById('stage');
  var frame = document.getElementById('appframe');
  var overlay = document.getElementById('overlay');
  var overlaycard = document.getElementById('overlaycard');

  var config = null;
  var sessionId = null;
  var sessionStart = null;
  var finished = false;
  var eventBuf = [];
  var interactionBuf = [];

  // Task-completion vs. session-end: when roaming is enabled the task can
  // finish well before the tester actually wraps up, so we latch the outcome
  // here and keep recording until they say they're done.
  var taskDone = false;
  var taskDoneAt = null;
  var pendingOutcome = null;

  // Success-signal chain progress. The injected recorder reloads on every
  // screen, so cross-screen state lives here: which click/screen signals have
  // latched, the last seen value of each value signal, and per-signal hit
  // times for the results funnel.
  var latched = {};
  var lastValue = {};
  var signalHits = [];
  var hitRecorded = {};

  function recordHit(i) {
    if (hitRecorded[i]) return;
    hitRecorded[i] = true;
    signalHits.push({ i: i, t: Date.now() - sessionStart });
  }

  // Terminal signal fired inside the artifact: success iff every earlier
  // click/screen signal latched at some point and every value signal is
  // satisfied — against the current DOM when it's on this screen (so
  // Tuesday→Monday→Confirm correctly fails), else by last seen value.
  function onTerminal(msg) {
    var sigs = config.signals || [];
    var byIndex = {};
    (msg.values || []).forEach(function (v) { byIndex[v.index] = v; });
    for (var i = 0; i < sigs.length; i++) {
      if (sigs[i].kind === 'value') {
        var v = byIndex[i];
        var ok = v && v.present ? v.satisfied : lastValue[i] === sigs[i].value;
        if (!ok) return;
      } else if (!latched[i]) {
        return;
      }
    }
    onTaskDone(true, false);
  }

  // Task detection (success or give-up) fired. If roaming is off, this ends
  // the session immediately, same as before. If roaming is on, the task's
  // own duration is latched and the taker keeps going in the live app until
  // they choose to wrap up.
  function onTaskDone(success, gaveUp) {
    if (taskDone) return;
    taskDone = true;
    if (!config.roamEnabled) return onFinish(success, gaveUp, Date.now() - sessionStart);
    taskDoneAt = Date.now();
    pendingOutcome = { success: success, gaveUp: gaveUp };
    document.getElementById('taskbarlabel').textContent = 'Task complete';
    document.getElementById('taskprompt').textContent = 'Feel free to keep exploring, or wrap up when you’re ready.';
    var btn = document.getElementById('giveup');
    btn.textContent = 'I’m done exploring';
    btn.onclick = function () {
      onFinish(pendingOutcome.success, pendingOutcome.gaveUp, taskDoneAt - sessionStart);
    };
  }

  function el(html) {
    var d = document.createElement('div');
    d.innerHTML = html;
    return d;
  }

  // ---------- upload plumbing ----------
  function postJson(path, body, beacon) {
    var url = api + '/sessions/' + sessionId + path;
    var json = JSON.stringify(body);
    if (beacon && navigator.sendBeacon) {
      navigator.sendBeacon(url, new Blob([json], { type: 'application/json' }));
      return Promise.resolve();
    }
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: json,
      keepalive: !!beacon,
    });
  }

  function flush(beacon) {
    if (!sessionId) return;
    if (eventBuf.length) {
      var evs = eventBuf; eventBuf = [];
      postJson('/events', { events: evs }, beacon);
    }
    if (interactionBuf.length) {
      var items = interactionBuf; interactionBuf = [];
      postJson('/interactions', { items: items }, beacon);
    }
  }
  setInterval(function () { flush(false); }, 2500);
  window.addEventListener('pagehide', function () {
    flush(true);
    if (sessionId && !finished) postJson('/abandon', { signalHits: signalHits }, true);
  });

  // ---------- recorder messages ----------
  window.addEventListener('message', function (e) {
    if (e.origin !== location.origin || !e.data || !e.data.__integral) return;
    var msg = e.data;
    if (msg.type === 'hello') {
      e.source.postMessage({ __integral: true, type: 'config', config: config }, location.origin);
    } else if (msg.type === 'events') {
      if (!finished) eventBuf = eventBuf.concat(msg.events);
    } else if (msg.type === 'interactions') {
      if (!finished) {
        for (var i = 0; i < msg.items.length; i++) {
          var it = msg.items[i];
          it.t = it.at - sessionStart;
          delete it.at;
          interactionBuf.push(it);
        }
      }
    } else if (msg.type === 'signal') {
      var i = msg.index;
      if (msg.kind === 'value') {
        lastValue[i] = msg.value;
        if (config.signals && config.signals[i] && msg.value === config.signals[i].value) recordHit(i);
      } else {
        latched[i] = true;
        recordHit(i);
      }
    } else if (msg.type === 'terminal') {
      if (!finished) onTerminal(msg);
    }
  });

  // ---------- flow ----------
  function showConsent() {
    gatecard.innerHTML =
      '<h1>' + escapeHtml(config.name) + '</h1>' +
      '<p>You’re about to try a short task in a prototype. It usually takes a couple of minutes.</p>' +
      '<p class="muted">This session is recorded for usability research (your clicks and movements — anything you type is masked; ' +
      '<a href="/privacy" target="_blank">privacy policy</a>). Continue?</p>' +
      '<button class="btn-primary" id="consent">Continue</button>' +
      '<p class="muted" style="margin-top:16px;font-size:12px"><a href="#" id="reportlink">Report this test</a></p>';
    document.getElementById('consent').onclick = config.screenerEnabled ? showScreener : startSession;
    document.getElementById('reportlink').onclick = function (e) { e.preventDefault(); showReport(); };
  }

  function showReport() {
    gatecard.innerHTML =
      '<h2>Report this test</h2>' +
      '<p class="muted">Flag this page if it looks like phishing, impersonation, or anything else abusive. A human reviews every report.</p>' +
      '<label>What’s wrong?</label>' +
      '<textarea id="reportdetail" placeholder="e.g. this pretends to be a bank login page"></textarea>' +
      '<div style="margin-top:12px"><button class="btn-primary" id="reportsend">Send report</button> ' +
      '<button id="reportcancel">Back</button></div>';
    document.getElementById('reportcancel').onclick = showConsent;
    document.getElementById('reportsend').onclick = function () {
      fetch(api + '/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'testee_flag', detail: document.getElementById('reportdetail').value }),
      }).then(function () {
        gatecard.innerHTML = '<h2>Thanks — report received.</h2><p class="muted">You can close this tab.</p>';
      });
    };
  }

  function showScreener() {
    gatecard.innerHTML =
      '<h2>One quick question</h2>' +
      '<label>' + escapeHtml(config.screenerQuestion || '') + '</label>' +
      '<input type="text" id="screener" autofocus>' +
      '<div style="margin-top:12px"><button class="btn-primary" id="go">Start task</button></div>';
    document.getElementById('go').onclick = function () {
      startSession(document.getElementById('screener').value);
    };
  }

  function startSession(screenerAnswer) {
    fetch(api + '/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ screenerAnswer: typeof screenerAnswer === 'string' ? screenerAnswer : null }),
    })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok) {
          showClosed(res.j.error === 'already_participated'
            ? 'You’ve already taken this test on this device — thanks!'
            : 'This test is closed.');
          return;
        }
        sessionId = res.j.sessionId;
        sessionStart = Date.now();
        gate.style.display = 'none';
        taskbar.style.display = 'flex';
        stage.style.display = 'block';
        document.getElementById('taskprompt').textContent = config.taskPrompt;
        frame.src = '/t/' + testId + '/app/' + (config.entryPath || '');
      });
  }

  function onFinish(success, gaveUp, taskDurationMs) {
    if (finished) return;
    finished = true;
    taskbar.style.display = 'none';
    flush(false);
    postJson('/finish', { success: success, gaveUp: gaveUp, signalHits: signalHits, taskDurationMs: taskDurationMs });
    overlay.style.display = 'flex';
    if (config.seqEnabled) showSeq(success);
    else afterSeq(success);
  }

  function afterSeq(success) {
    if (config.notesEnabled) showNotes(success);
    else showThanks(success);
  }

  function showNotes(success) {
    overlaycard.innerHTML =
      '<h2>One more thing</h2>' +
      '<label>Anything else you’d like to share about your experience? (optional)</label>' +
      '<textarea id="notesinput"></textarea>' +
      '<div style="margin-top:12px"><button class="btn-primary" id="notessubmit">Submit</button></div>';
    document.getElementById('notessubmit').onclick = function () {
      postJson('/notes', { notes: document.getElementById('notesinput').value });
      showThanks(success);
    };
  }

  function showSeq(success) {
    var seqScore = null;
    overlaycard.innerHTML =
      '<h2>' + (success ? 'Task complete 🎉' : 'Thanks for trying!') + '</h2>' +
      '<p>Overall, how difficult or easy was the task to complete?</p>' +
      '<div class="seq-scale" id="scale"></div>' +
      '<div class="seq-ends"><span>Very difficult</span><span>Very easy</span></div>' +
      '<label>Anything that tripped you up? (optional)</label>' +
      '<textarea id="seqcomment"></textarea>' +
      '<div style="margin-top:12px"><button class="btn-primary" id="seqsubmit" disabled>Submit</button></div>';
    var scale = document.getElementById('scale');
    for (var n = 1; n <= 7; n++) {
      (function (n) {
        var b = document.createElement('button');
        b.textContent = n;
        b.onclick = function () {
          seqScore = n;
          Array.prototype.forEach.call(scale.children, function (c) { c.classList.remove('sel'); });
          b.classList.add('sel');
          document.getElementById('seqsubmit').disabled = false;
        };
        scale.appendChild(b);
      })(n);
    }
    document.getElementById('seqsubmit').onclick = function () {
      postJson('/seq', { score: seqScore, comment: document.getElementById('seqcomment').value });
      afterSeq(success);
    };
  }

  function showThanks(success) {
    overlay.style.display = 'flex';
    overlaycard.innerHTML =
      '<h2>' + (success ? 'All done — thank you!' : 'Thanks for your time!') + '</h2>' +
      '<p class="muted">Your session helps make this product better. You can close this tab.</p>';
  }

  function showClosed(msg) {
    gate.style.display = 'flex';
    taskbar.style.display = 'none';
    stage.style.display = 'none';
    gatecard.className = 'card gate-closed';
    gatecard.innerHTML = '<h2>' + msg + '</h2>';
  }

  function escapeHtml(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : s;
    return d.innerHTML;
  }

  document.getElementById('giveup').onclick = function () { onTaskDone(false, true); };

  fetch(api + '/config')
    .then(function (r) { return r.json(); })
    .then(function (c) {
      config = c;
      if (!c.open) return showClosed('This test is closed.');
      showConsent();
    })
    .catch(function () { showClosed('Something went wrong loading this test.'); });
})();
