(function () {
  'use strict';
  var testId = location.pathname.split('/')[2];
  var frame = document.getElementById('frame');
  var mode = 'pick';
  var test = null;
  // Origin the preview iframe is served from. Under the origin split (hosted
  // artifacts live on their own host so they can't reach dashboard cookies)
  // this is NOT our origin, and every postMessage between us and the picker
  // has to name it — a mismatched target origin is dropped silently, which
  // reads as "recording just doesn't add steps". Filled in from the test API;
  // same-origin until then, which is the whole story in dev.
  var runOrigin = location.origin;
  // Ordered success-signal chain; the last chip is the terminal action.
  var signals = [];

  function $(id) { return document.getElementById(id); }

  function setMode(m) {
    mode = m;
    $('mode-pick').classList.toggle('active', m === 'pick');
    $('mode-browse').classList.toggle('active', m === 'browse');
    if (frame.contentWindow) {
      frame.contentWindow.postMessage({ __integral: true, type: 'mode', mode: m }, runOrigin);
    }
  }
  $('mode-pick').onclick = function () { setMode('pick'); };
  $('mode-browse').onclick = function () { setMode('browse'); };

  window.addEventListener('message', function (e) {
    if (e.origin !== runOrigin || e.source !== frame.contentWindow) return;
    if (!e.data || !e.data.__integral) return;
    if (e.data.type === 'pickerReady') {
      $('curpage').textContent = 'Screen: ' + (e.data.page || test.entry_path);
      setMode(mode); // re-send mode after navigation
    } else if (e.data.type === 'picked') {
      addSignal({
        kind: e.data.kind,
        selector: e.data.selector,
        value: e.data.value,
        label: e.data.label,
        page: e.data.page || test.entry_path,
      });
    }
  });

  function chipKey(sig) {
    return sig.kind + '|' + (sig.kind === 'screen' ? sig.screen : sig.selector + '|' + sig.page);
  }

  function addSignal(sig) {
    if (sig.kind !== 'value') delete sig.value;
    var last = signals[signals.length - 1];
    // Same element again (double-click, or re-changing a field to a new
    // value) refines the last step instead of stacking duplicates.
    if (last && chipKey(last) === chipKey(sig)) {
      signals[signals.length - 1] = sig;
    } else {
      signals.push(sig);
    }
    renderChips();
  }

  function renderChips() {
    var ol = $('chips');
    ol.innerHTML = '';
    signals.forEach(function (sig, i) {
      var li = document.createElement('li');
      if (i === signals.length - 1) li.className = 'finish';
      var body = document.createElement('div');
      body.className = 'body';
      var glyph = sig.kind === 'value' ? '☑ ' : sig.kind === 'screen' ? '⛿ ' : '🖱 ';
      body.appendChild(document.createTextNode(glyph + (sig.label || sig.screen || '')));
      var code = document.createElement('code');
      code.textContent = sig.kind === 'screen' ? sig.screen : sig.selector;
      body.appendChild(code);
      var del = document.createElement('button');
      del.className = 'del';
      del.textContent = '✕';
      del.title = 'Remove step';
      del.onclick = function () { signals.splice(i, 1); renderChips(); };
      li.appendChild(body);
      li.appendChild(del);
      ol.appendChild(li);
    });
    $('chiphint').style.display = signals.length ? 'none' : '';
  }

  $('clearchips').onclick = function () { signals = []; renderChips(); };
  $('addscreen').onclick = function () {
    var screen = $('screen_add').value;
    if (!screen) return;
    addSignal({ kind: 'screen', screen: screen, label: 'reached ' + screen });
  };
  $('screener_enabled').onchange = function () {
    $('screenerrow').style.display = this.checked ? '' : 'none';
  };
  $('entry_path').onchange = function () { loadPreview(this.value); };

  // Absolute against runOrigin, not relative: a relative src would load from
  // the dashboard and eat a redirect to the run host on every screen.
  function loadPreview(page) {
    frame.src = runOrigin + '/t/' + testId + '/preview/' + (page || '');
  }

  function payload() {
    var body = {
      name: $('name').value,
      task_prompt: $('task_prompt').value,
      entry_path: $('entry_path').value,
      seq_enabled: $('seq_enabled').checked,
      notes_enabled: $('notes_enabled').checked,
      roam_enabled: $('roam_enabled').checked,
      screener_enabled: $('screener_enabled').checked,
      screener_question: $('screener_question').value,
      response_cap: Number($('response_cap').value) || 25,
      unmask_selectors: $('unmask_selectors').value,
      api_mocks: gatherMocks(),
    };
    // The API rejects an empty chain, and a draft may not have steps yet —
    // only send the chain once there's something to say.
    if (signals.length) body.success_signals = signals;
    return body;
  }

  // ---------- sandbox API mocks ----------

  var mocksDirty = false;
  var METHODS = ['ANY', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

  function addMockRow(m) {
    m = m || {};
    var div = document.createElement('div');
    div.className = 'mockrow';
    var line = document.createElement('div');
    line.className = 'rowline';
    var method = document.createElement('select');
    method.className = 'm-method';
    METHODS.forEach(function (x) { method.appendChild(new Option(x, x, false, x === (m.method || 'ANY'))); });
    var url = document.createElement('input');
    url.className = 'm-url';
    url.type = 'text';
    url.placeholder = '/api/events or https://api.example.com/*';
    url.value = m.url || '';
    var status = document.createElement('input');
    status.className = 'm-status';
    status.type = 'number';
    status.min = 100; status.max = 599;
    status.value = m.status || 200;
    var del = document.createElement('button');
    del.className = 'm-del';
    del.title = 'Remove mock';
    del.textContent = '✕';
    del.onclick = function () { div.remove(); mocksDirty = true; };
    line.appendChild(method); line.appendChild(url); line.appendChild(status); line.appendChild(del);
    var body = document.createElement('textarea');
    body.className = 'm-body';
    body.placeholder = '{"ok": true}   ← response body (JSON or text)';
    body.value = m.body || '';
    div.appendChild(line);
    div.appendChild(body);
    div.oninput = function () { mocksDirty = true; };
    $('mockrows').appendChild(div);
    return div;
  }

  function gatherMocks() {
    var out = [];
    document.querySelectorAll('#mockrows .mockrow').forEach(function (row) {
      var url = row.querySelector('.m-url').value.trim();
      if (!url) return;
      out.push({
        method: row.querySelector('.m-method').value,
        url: url,
        status: Number(row.querySelector('.m-status').value) || 200,
        body: row.querySelector('.m-body').value,
      });
    });
    return out;
  }

  function renderMocks() {
    $('mockrows').innerHTML = '';
    (test.apiMocks || []).forEach(addMockRow);
  }

  $('addmock').onclick = function () { addMockRow().querySelector('.m-url').focus(); };

  function loadSuggestions() {
    fetch('/api/tests/' + testId + '/api-suggestions')
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var calls = (j.calls || []).filter(function (c) {
          return !(test.apiMocks || []).some(function (m) { return m.url === c.url; });
        });
        if (!calls.length) return;
        $('mocksuggest').style.display = '';
        calls.forEach(function (c) {
          var chip = document.createElement('span');
          chip.className = 'sugchip';
          chip.textContent = c.method + ' ' + c.url;
          chip.onclick = function () {
            chip.remove();
            addMockRow({ method: c.method, url: c.url }).querySelector('.m-body').focus();
            mocksDirty = true;
          };
          $('suggestchips').appendChild(chip);
        });
      });
  }

  function save(extra) {
    var body = Object.assign(payload(), extra || {});
    return fetch('/api/tests/' + testId, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) throw new Error(j.message || j.error);
        test = j;
        render();
        // Mock rules are baked into the served pages; reload so the preview
        // picks up the new sandbox responses.
        if (mocksDirty) {
          mocksDirty = false;
          loadPreview($('entry_path').value);
        }
        return j;
      });
    });
  }

  $('save').onclick = function () {
    save().then(function () { msg('Saved.'); }).catch(function (e) { msg(e.message); });
  };
  $('launch').onclick = function () {
    if (!signals.length) return msg('Record at least one success step first.');
    if (!$('task_prompt').value.trim()) return msg('Write a task prompt first.');
    save({ status: 'live' }).then(function () { msg('Live! Share the link below.'); }).catch(function (e) { msg(e.message); });
  };
  $('deletetest').onclick = function () {
    if (test.status === 'live') {
      save({ status: 'closed' }).then(function () { msg('Test closed.'); });
      return;
    }
    if (!confirm('Delete this test and all its sessions?')) return;
    fetch('/api/tests/' + testId, { method: 'DELETE' }).then(function () { location.href = '/'; });
  };
  $('copy').onclick = function () {
    navigator.clipboard.writeText($('sharelink').value).then(function () { msg('Copied.'); });
  };

  function msg(s) { $('savemsg').textContent = s; }

  // ---------- server-rendered backend config (fake-backend sandbox) ----------

  $('backendsave').onclick = function () {
    var cfg;
    try {
      cfg = JSON.parse($('backendjson').value);
    } catch (e) {
      return ($('backendmsg').textContent = 'Not valid JSON: ' + e.message);
    }
    $('backendmsg').textContent = 'Saving…';
    fetch('/api/tests/' + testId + '/backend-config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ backendConfig: cfg }),
    })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok) return ($('backendmsg').textContent = res.j.message || 'Save failed');
        test = res.j;
        $('backendmsg').textContent = 'Saved — app restarting with new config…';
        render();
        // The first request after a config change boots the sandbox; the
        // preview shows a boot-error page with logs if it fails.
        loadPreview($('entry_path').value);
      });
  };

  $('repopull').onclick = function () {
    $('repopullmsg').textContent = 'Pulling…';
    fetch('/api/tests/' + testId + '/pull', { method: 'POST' })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok) return ($('repopullmsg').textContent = res.j.message || 'Pull failed');
        test = res.j;
        $('repopullmsg').textContent = 'Up to date.';
        render();
        loadPreview(test.entry_path);
      });
  };

  function render() {
    $('crumb').textContent = test.name + ' · ' + test.status;
    $('name').value = test.name;
    $('task_prompt').value = test.task_prompt || '';
    $('response_cap').value = test.response_cap;
    $('seq_enabled').checked = !!test.seq_enabled;
    $('notes_enabled').checked = !!test.notes_enabled;
    $('roam_enabled').checked = !!test.roam_enabled;
    $('screener_enabled').checked = !!test.screener_enabled;
    $('screenerrow').style.display = test.screener_enabled ? '' : 'none';
    $('screener_question').value = test.screener_question || '';
    $('unmask_selectors').value = test.unmask_selectors || '';
    $('resultslink').href = '/tests/' + testId + '/results';
    $('deletetest').textContent = test.status === 'live' ? 'Close' : 'Delete';

    var entrySel = $('entry_path');
    var screenSel = $('screen_add');
    entrySel.innerHTML = screenSel.innerHTML = '';
    (test.html_files || []).forEach(function (f) {
      entrySel.appendChild(new Option(f, f, false, f === test.entry_path));
      screenSel.appendChild(new Option(f, f));
    });
    // Screen-reached steps only make sense for multi-page artifacts.
    $('screenaddrow').style.display = (test.html_files || []).length > 1 ? '' : 'none';

    $('backendcard').style.display = test.backendConfig ? '' : 'none';
    if (test.backendConfig && document.activeElement !== $('backendjson')) {
      $('backendjson').value = JSON.stringify(test.backendConfig, null, 2);
    }

    $('repobar').style.display = test.source_type === 'repo' ? '' : 'none';
    if (test.source_type === 'repo') {
      $('repoinfo').textContent =
        test.repo_full_name + ' @ ' + test.repo_branch +
        (test.repo_path ? ' /' + test.repo_path : '') +
        (test.repo_synced_at ? ' · pulled ' + new Date(test.repo_synced_at).toLocaleString() : '');
    }

    // Server truth: legacy single-target rows arrive synthesized as a 1-chip chain.
    signals = test.signals || [];
    renderChips();
    renderMocks();

    var live = test.status === 'live' || test.status === 'closed';
    $('sharebox').style.display = live ? '' : 'none';
    if (live) $('sharelink').value = location.origin + '/t/' + testId;
  }

  fetch('/api/tests/' + testId)
    .then(function (r) { return r.json(); })
    .then(function (t) {
      test = t;
      if (t.run_origin) runOrigin = t.run_origin;
      render();
      loadPreview(t.entry_path);
      loadSuggestions();
    });
})();
