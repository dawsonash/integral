(function () {
  'use strict';

  var me = null;

  function show(id, on) { document.getElementById(id).style.display = on ? '' : 'none'; }
  function msg(s) { document.getElementById('createmsg').textContent = s; }
  function fmtDate(ts) { return new Date(ts).toLocaleDateString(); }

  // ---------- auth ----------

  function showApp() {
    show('main', true);
    var acct = document.getElementById('account');
    acct.style.display = 'flex';
    document.getElementById('whoami').textContent = me.login;
    document.getElementById('planbadge').textContent = me.plan;
    var u = me.usage, l = me.limits;
    document.getElementById('usage').textContent =
      u.responsesThisMonth + (l.responsesPerMonth ? ' / ' + l.responsesPerMonth : '') + ' responses this month';
    if (me.billingConfigured) {
      show('upgrade', me.plan === 'free');
      show('managebilling', me.plan !== 'free');
    }
    loadRepos();
    loadTests();
  }

  // ---------- repo picker ----------

  var repos = [];

  function loadRepos() {
    fetch('/api/github/repos').then(function (r) { return r.json(); }).then(function (j) {
      show('repo-disconnected', !j.connected);
      show('repo-picker', !!j.connected);
      if (!j.connected) {
        show('repoconnect', !!j.available);
        show('repo-unavailable', !j.available);
        return;
      }
      repos = j.repos || [];
      var sel = document.getElementById('repo');
      sel.innerHTML = '';
      repos.forEach(function (r) {
        sel.appendChild(new Option(r.full_name + (r.private ? ' (private)' : ''), r.full_name));
      });
      sel.onchange = function () {
        var r = repos.filter(function (x) { return x.full_name === sel.value; })[0];
        document.getElementById('repo_branch').value = r ? r.default_branch : '';
        loadTree();
      };
      document.getElementById('repo_branch').onchange = loadTree;
      sel.onchange();
    });
  }

  // Scan the chosen branch for start pages — HTML files plus React entry
  // modules (src/main.jsx and friends) — so the developer picks by sight
  // instead of guessing a build-folder path.
  var treeSeq = 0;
  function loadTree() {
    var repo = document.getElementById('repo').value;
    var ref = document.getElementById('repo_branch').value.trim();
    var sel = document.getElementById('repo_entry');
    var emsg = document.getElementById('repo_entry_msg');
    var seq = ++treeSeq;
    sel.innerHTML = '';
    show('repo_entry', false);
    show('repo_preview', false);
    if (!repo || !ref) return;
    emsg.style.display = '';
    emsg.textContent = 'Scanning branch for pages…';
    fetch('/api/github/tree?repo=' + encodeURIComponent(repo) + '&ref=' + encodeURIComponent(ref))
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (seq !== treeSeq) return; // a newer scan superseded this one
        var files = j.html || [];
        var modules = j.modules || [];
        if (!files.length && !modules.length) {
          emsg.textContent = j.message ||
            'No start pages on this branch — no HTML files and no React or Ink entry module (like src/main.jsx or source/cli.tsx). Commit one, or use the other tabs.';
          return;
        }
        emsg.style.display = 'none';
        show('repo_entry', true);
        files.forEach(function (f) { sel.appendChild(new Option(f, f)); });
        modules.forEach(function (f) { sel.appendChild(new Option(f + ' (app entry)', f)); });
        sel.onchange = loadEntryPreview;
        loadEntryPreview();
      });
  }

  // Live preview: the server pulls a snapshot of the branch and hosts it
  // through the same pipeline as a real test (JSX transpiled, CSS and images
  // resolving), so React entries render exactly as testers will see them.
  var previewSeq = 0;
  function loadEntryPreview() {
    var repo = document.getElementById('repo').value;
    var ref = document.getElementById('repo_branch').value.trim();
    var entry = document.getElementById('repo_entry').value;
    var frame = document.getElementById('repo_preview');
    var emsg = document.getElementById('repo_entry_msg');
    var seq = ++previewSeq;
    if (!entry) return;
    emsg.style.display = '';
    emsg.textContent = 'Loading preview…';
    fetch('/api/github/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: repo, ref: ref, entry: entry }),
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (seq !== previewSeq) return;
        if (!j.id) {
          emsg.textContent = j.message || 'Preview failed.';
          return;
        }
        emsg.style.display = 'none';
        frame.src = '/p/' + j.id + '/' + j.path;
        show('repo_preview', true);
      });
  }

  document.getElementById('logout').onclick = function () {
    fetch('/auth/logout', { method: 'POST' }).then(function () { location.reload(); });
  };

  document.getElementById('deleteaccount').onclick = function (e) {
    e.preventDefault();
    if (!confirm('Delete your account? This permanently removes every test, uploaded artifact, and recorded session. There is no undo.')) return;
    fetch('/api/account', { method: 'DELETE' }).then(function () { location.reload(); });
  };

  // ---------- billing ----------

  function billingRedirect(path) {
    fetch(path, { method: 'POST' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j.url) location.href = j.url;
        else alert(j.message || 'Billing is not available right now.');
      });
  }
  document.getElementById('upgrade').onclick = function () { billingRedirect('/api/billing/checkout'); };
  document.getElementById('managebilling').onclick = function () { billingRedirect('/api/billing/portal'); };

  // ---------- create test ----------

  document.querySelectorAll('.tabs button').forEach(function (b) {
    b.onclick = function () {
      document.querySelectorAll('.tabs button').forEach(function (x) { x.classList.remove('active'); });
      b.classList.add('active');
      document.querySelectorAll('[data-pane]').forEach(function (p) {
        p.style.display = p.dataset.pane === b.dataset.tab ? '' : 'none';
      });
    };
  });

  document.getElementById('create').onclick = function () {
    var fd = new FormData();
    fd.append('name', document.getElementById('name').value);
    var tab = document.querySelector('.tabs button.active').dataset.tab;
    if (tab === 'repo') {
      var repoSel = document.getElementById('repo');
      if (!repoSel.value) return msg('Connect GitHub and choose a repository first.');
      if (!document.getElementById('repo_entry').value) return msg('Pick a start page first.');
      fd.append('repo', repoSel.value);
      fd.append('branch', document.getElementById('repo_branch').value);
      fd.append('entry', document.getElementById('repo_entry').value);
    } else if (tab === 'html') {
      if (!document.getElementById('html').value.trim()) return msg('Paste some HTML first.');
      fd.append('html', document.getElementById('html').value);
    } else if (tab === 'zip') {
      var z = document.getElementById('zip').files[0];
      if (!z) return msg('Choose a zip file.');
      fd.append('zip', z);
    } else {
      var files = document.getElementById('folder').files;
      if (!files.length) return msg('Choose a folder.');
      var paths = [];
      for (var i = 0; i < files.length; i++) {
        fd.append('files', files[i]);
        paths.push(files[i].webkitRelativePath || files[i].name);
      }
      fd.append('paths', JSON.stringify(paths));
    }
    msg('Creating…');
    fetch('/api/tests', { method: 'POST', body: fd })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok) return msg(res.j.message || res.j.error || 'Failed');
        location.href = '/tests/' + res.j.id + '/setup';
      });
  };

  document.getElementById('sample').onclick = function () {
    fetch('/api/tests/sample', { method: 'POST' })
      .then(function (r) { return r.json(); })
      .then(function (t) { location.href = '/tests/' + t.id + '/setup'; });
  };

  // ---------- test list ----------

  function loadTests() {
    fetch('/api/tests').then(function (r) { return r.json(); }).then(function (tests) {
      var tbody = document.querySelector('#tests tbody');
      tbody.innerHTML = '';
      show('empty', !tests.length);
      tests.forEach(function (t) {
        var tr = document.createElement('tr');
        tr.innerHTML =
          '<td><a href="/tests/' + t.id + '/setup"></a></td>' +
          '<td><span class="badge ' + t.status + '">' + t.status + '</span></td>' +
          '<td>' + t.completed_count + ' / ' + t.response_cap + '</td>' +
          '<td class="muted">' + fmtDate(t.created_at) + '</td>' +
          '<td><a class="btn btn-sm" href="/tests/' + t.id + '/results">Results</a></td>';
        tr.querySelector('a').textContent = t.name;
        tbody.appendChild(tr);
      });
    });
  }

  // ---------- boot ----------

  fetch('/api/me').then(function (r) {
    // Session expired: back to the front door, which serves the landing page.
    if (r.status === 401) return location.replace('/');
    return r.json().then(function (j) { me = j; showApp(); });
  });
})();
