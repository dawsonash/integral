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
    document.getElementById('planbadge').textContent = me.planLabel || me.plan;
    var u = me.usage, l = me.limits;
    document.getElementById('usage').textContent =
      u.responsesThisMonth + (l.responsesPerMonth ? ' / ' + l.responsesPerMonth : '') + ' responses this month';
    if (me.billingConfigured) {
      show('upgrade', me.plan === 'free');
      // Team members don't hold the subscription — only the owner gets a
      // billing button, since the portal would 400 for everyone else.
      show('managebilling', me.plan !== 'free' && (!me.team || me.team.role === 'owner'));
    }
    // On a team the pool is shared, so the list isn't "yours" any more.
    document.getElementById('testsheading').textContent = me.team ? me.team.name + ' — tests' : 'Your tests';
    loadTeam();
    loadRepos();
    loadTests();
  }

  // ---------- team ----------

  function loadTeam() {
    if (!me.team) return show('teamcard', false);
    fetch('/api/team').then(function (r) { return r.json(); }).then(function (j) {
      var t = j.team;
      if (!t) return show('teamcard', false);
      show('teamcard', true);
      document.getElementById('teamheading').textContent = t.name;
      document.getElementById('teamsummary').textContent =
        t.seats + (t.seats === 1 ? ' seat' : ' seats') + ' · ' +
        t.limits.activeTests + ' active tests · ' + t.limits.responsesPerMonth + ' responses / month' +
        (t.role === 'owner' && t.plan === 'team'
          ? ' · billed ' + (t.billingInterval === 'year' ? 'yearly' : 'monthly') +
            ', ' + t.billableSeats + ' paid seat' + (t.billableSeats === 1 ? '' : 's') + ' beyond yours'
          : '');

      var tbody = document.querySelector('#teammembers tbody');
      tbody.innerHTML = '';
      t.members.forEach(function (m) {
        var tr = document.createElement('tr');
        tr.innerHTML =
          '<td class="js-login"></td><td class="muted">' + m.role + '</td>' +
          '<td class="muted">' + fmtDate(m.joined_at) + '</td><td class="js-act"></td>';
        tr.querySelector('.js-login').textContent = m.login + (m.id === me.id ? ' (you)' : '');
        if (t.role === 'owner' && m.role !== 'owner') {
          var b = document.createElement('button');
          b.className = 'btn-sm';
          b.textContent = 'Remove';
          b.onclick = function () {
            if (!confirm('Remove ' + m.login + ' from the team? Their tests stay with the team, and the seat stops being billed.')) return;
            fetch('/api/team/members/' + m.id, { method: 'DELETE' }).then(function () { location.reload(); });
          };
          tr.querySelector('.js-act').appendChild(b);
        }
        tbody.appendChild(tr);
      });

      show('teamowner', t.role === 'owner');
      show('deleteteam', t.role === 'owner');
      show('leaveteam', t.role !== 'owner');

      var itable = document.getElementById('teaminvites');
      var ibody = itable.querySelector('tbody');
      ibody.innerHTML = '';
      itable.style.display = t.invites.length ? '' : 'none';
      t.invites.forEach(function (inv) {
        var tr = document.createElement('tr');
        tr.innerHTML = '<td class="js-who"></td><td><input class="js-url" readonly style="width:100%"></td><td class="js-act"></td>';
        tr.querySelector('.js-who').textContent = inv.invitee;
        tr.querySelector('.js-url').value = inv.url;
        var b = document.createElement('button');
        b.className = 'btn-sm';
        b.textContent = 'Revoke';
        b.onclick = function () {
          fetch('/api/team/invites/' + inv.id, { method: 'DELETE' }).then(function () { loadTeam(); });
        };
        tr.querySelector('.js-act').appendChild(b);
        ibody.appendChild(tr);
      });
    });
  }

  document.getElementById('invite').onclick = function () {
    var el = document.getElementById('invitee');
    var msgEl = document.getElementById('invitemsg');
    if (!el.value.trim()) return (msgEl.textContent = 'Enter a GitHub username or email address.');
    msgEl.textContent = 'Inviting…';
    fetch('/api/team/invites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ invitee: el.value.trim() }),
    })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok) return (msgEl.textContent = res.j.message || 'Invite failed.');
        el.value = '';
        msgEl.textContent = 'Invite created — send them the link below.';
        loadTeam();
      });
  };

  document.getElementById('leaveteam').onclick = function (e) {
    e.preventDefault();
    if (!confirm('Leave this team? Tests you created inside it stay with the team.')) return;
    fetch('/api/team/members/' + me.id, { method: 'DELETE' }).then(function () { location.reload(); });
  };

  document.getElementById('deleteteam').onclick = function (e) {
    e.preventDefault();
    if (!confirm('Delete this team? The subscription is cancelled and every test reverts to your personal account.')) return;
    fetch('/api/team', { method: 'DELETE' }).then(function () { location.reload(); });
  };

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

  function billingRedirect(path, body) {
    return fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j.url) location.href = j.url;
        else document.getElementById('plansmsg').textContent = j.message || 'Billing is not available right now.';
      });
  }

  // Monthly/yearly, mirroring the landing page's toggle. Yearly is exactly 10%
  // off, displayed as the equivalent monthly figure with the real annual
  // amount in the note underneath.
  var RATES = {
    month: {
      individual: '20', team: '20', seat: '10',
      notes: { individual: 'Billed monthly.', team: 'Billed monthly. Base includes your seat.' },
    },
    year: {
      individual: '18', team: '18', seat: '9',
      notes: {
        individual: '$216 billed yearly.',
        team: '$216 + $108 per teammate, billed yearly. Base includes your seat.',
      },
    },
  };
  var interval = 'month';
  try { interval = localStorage.getItem('integral_billing_interval') === 'year' ? 'year' : 'month'; } catch (e) {}

  function renderPrices() {
    var r = RATES[interval];
    document.querySelectorAll('#plans [data-price]').forEach(function (el) {
      el.textContent = r[el.getAttribute('data-price')];
    });
    document.querySelectorAll('#plans [data-note]').forEach(function (el) {
      el.textContent = r.notes[el.getAttribute('data-note')];
    });
    document.querySelectorAll('#interval button').forEach(function (b) {
      b.classList.toggle('active', b.dataset.interval === interval);
    });
  }

  document.querySelectorAll('#interval button').forEach(function (b) {
    b.onclick = function () {
      interval = b.dataset.interval;
      try { localStorage.setItem('integral_billing_interval', interval); } catch (e) {}
      renderPrices();
    };
  });

  document.querySelectorAll('#plans [data-buy]').forEach(function (b) {
    b.onclick = function () {
      var plan = b.dataset.buy;
      document.getElementById('plansmsg').textContent = 'Opening checkout…';
      billingRedirect('/api/billing/checkout', {
        plan: plan,
        interval: interval,
        teamName: document.getElementById('teamname').value,
      });
    };
  });

  document.getElementById('upgrade').onclick = function () {
    renderPrices();
    show('plans', true);
    document.getElementById('plans').scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
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
      // "Created by" only earns its column when more than one person can
      // appear in it.
      var showAuthor = !!me.team;
      document.querySelector('#tests .col-author').style.display = showAuthor ? '' : 'none';
      tests.forEach(function (t) {
        var tr = document.createElement('tr');
        tr.innerHTML =
          '<td><a href="/tests/' + t.id + '/setup"></a></td>' +
          (showAuthor ? '<td class="muted js-author"></td>' : '') +
          '<td><span class="badge ' + t.status + '">' + t.status + '</span></td>' +
          '<td>' + t.completed_count + ' / ' + t.response_cap + '</td>' +
          '<td class="muted">' + fmtDate(t.created_at) + '</td>' +
          '<td><a class="btn btn-sm" href="/tests/' + t.id + '/results">Results</a></td>';
        tr.querySelector('a').textContent = t.name;
        if (showAuthor) tr.querySelector('.js-author').textContent = t.author || '—';
        tbody.appendChild(tr);
      });
    });
  }

  // ---------- boot ----------

  // Someone who followed an invite link while signed out was sent through
  // GitHub, which always lands back here. Finish the join they started.
  function pendingJoin() {
    var token = null;
    try {
      token = localStorage.getItem('integral_pending_join');
      localStorage.removeItem('integral_pending_join');
    } catch (e) {}
    if (!token) return Promise.resolve();
    return fetch('/api/team/join/' + token, { method: 'POST' })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) { if (!res.ok) alert(res.j.message || 'That invite could not be accepted.'); })
      .catch(function () {});
  }

  pendingJoin().then(function () {
    fetch('/api/me').then(function (r) {
      // Session expired: back to the front door, which serves the landing page.
      if (r.status === 401) return location.replace('/');
      return r.json().then(function (j) { me = j; showApp(); });
    });
  });
})();
