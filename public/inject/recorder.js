// Integral recorder — injected into every HTML screen of a hosted artifact in
// taker mode. Runs inside the same-origin iframe; streams rrweb events and
// lightweight interaction samples to the parent shell via postMessage. The
// parent owns the session and does all server communication.
(function () {
  'use strict';
  if (window.__integralRecorder) return;
  window.__integralRecorder = true;
  if (window.top === window) return; // only meaningful inside the taker shell

  var ORIGIN = location.origin;
  var config = null;
  var eventBuf = [];
  var interactionBuf = [];
  // Success-signal chain state, per page-load. The parent shell owns the
  // cross-screen latch state and the success verdict; we only report raw hits
  // and, when the terminal (last) signal fires, a fresh evaluation of every
  // value signal against the current DOM.
  var postedHits = {};

  // ---- screen tracking ----
  // Interactions are bucketed per *screen*, not per page-load: the route part
  // (path under /t/:id/app, plus router-shaped hashes) tracks SPA navigation,
  // and a DOM-swap detector splits screens that change without any URL change
  // (single-file apps, JS-toggled views). Screen keys look like
  // "cart.html", "index.html#/checkout", or "index.html::Payment".
  var ROUTE = computeRoute();
  var domPart = '';       // '::<name>' suffix source for the current DOM screen
  var domInfo = null;     // {name, sparse, node, rebased} baseline screen for the current route
  var domNames = {};      // distinct DOM screens this page-load (cardinality cap)
  var domCount = 0;
  var suppressUntil = 0;  // ignore DOM-swap commits right after a route change
  var chromeNodes = new WeakSet(); // headings that survived a swap: persistent site chrome
  var prevHeadings = []; // [{el, text, tag}] visible-heading snapshot of the last-evaluated screen

  // Scroll depth is tracked per screen; module-scoped so a screen change can
  // flush the pending depth to the screen being left.
  var maxScroll = 0;
  var scrollTimer = null;

  function computeRoute() {
    // Path relative to the artifact root. A SPA may pushState *out* of the
    // mount ("/dashboard"); fall back to the bare pathname so screens still
    // get distinct keys instead of collapsing back to the entry.
    var m = location.pathname.match(/^\/t\/[^/]+\/app\/?(.*)$/);
    var route = m ? m[1] : location.pathname.replace(/^\//, '');
    // Router-shaped hashes ("#/settings", "#!/inbox") are navigation;
    // fragment anchors ("#section") are not.
    if (/^#[!/]/.test(location.hash)) route += location.hash;
    return route;
  }

  function routeOrEntry() {
    return ROUTE || (config && config.entryPath) || '';
  }

  function currentScreen() {
    return domPart ? routeOrEntry() + '::' + domPart : routeOrEntry();
  }

  function post(type, payload) {
    try {
      window.parent.postMessage(Object.assign({ __integral: true, type: type }, payload), ORIGIN);
    } catch (e) { /* parent gone */ }
  }

  function flush() {
    if (eventBuf.length) {
      post('events', { events: eventBuf });
      eventBuf = [];
    }
    if (interactionBuf.length) {
      post('interactions', { items: interactionBuf });
      interactionBuf = [];
    }
  }

  function signals() {
    return (config && config.signals) || [];
  }

  function readValue(el) {
    // Must mirror the picker's convention exactly.
    if (el.type === 'checkbox') return el.checked ? 'true' : 'false';
    return String(el.value == null ? '' : el.value);
  }

  function postHit(index, kind, value) {
    if (kind !== 'value') {
      if (postedHits[index]) return;
      postedHits[index] = true;
    }
    post('signal', { index: index, kind: kind, value: value, page: ROUTE, at: Date.now() });
  }

  // Not latched: the tester may fire the terminal action, be ruled "not
  // satisfied" by the shell (wrong path), correct their input on the same
  // page-load, and fire it again. The shell ignores terminals after success.
  function evalTerminal(index) {
    var values = [];
    var sigs = signals();
    for (var i = 0; i < sigs.length; i++) {
      if (sigs[i].kind !== 'value') continue;
      var el = null;
      try { el = document.querySelector(sigs[i].selector); } catch (e) { /* bad selector */ }
      values.push({
        index: i,
        present: !!el,
        satisfied: !!el && readValue(el) === sigs[i].value,
        value: el ? readValue(el) : null,
      });
    }
    flush();
    post('terminal', { index: index, page: ROUTE, values: values, at: Date.now() });
  }

  function docHeight() {
    var b = document.body, e = document.documentElement;
    return Math.max(b ? b.scrollHeight : 0, e ? e.scrollHeight : 0, window.innerHeight);
  }

  function addInteraction(kind, x, y) {
    interactionBuf.push({
      kind: kind, x: x, y: y, page: currentScreen(),
      vw: window.innerWidth, vh: window.innerHeight, dh: docHeight(), at: Date.now(),
    });
  }

  // ---- screen naming ----

  function isVisible(el) {
    return !!(el.offsetWidth || el.offsetHeight || (el.getClientRects && el.getClientRects().length));
  }

  function cleanName(s) {
    return String(s).replace(/::/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 48);
  }

  function fnv(s) {
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
      h >>>= 0;
    }
    return ('00000000' + h.toString(16)).slice(-8).slice(0, 6);
  }

  function inDoc(el) {
    return !!(el && document.documentElement && document.documentElement.contains(el));
  }

  // Headings inside an open dialog belong to the overlay, not the screen.
  function inDialog(el) {
    try {
      return !!(el.closest && el.closest('dialog,[role=dialog],[aria-modal="true"]'));
    } catch (e) { return false; }
  }

  function snapshotHeadings() {
    var out = [];
    var hs = document.querySelectorAll('h1,h2');
    for (var i = 0; i < hs.length; i++) {
      if (!isVisible(hs[i]) || inDialog(hs[i])) continue;
      var t = cleanName(hs[i].textContent);
      if (t) out.push({ el: hs[i], text: t, tag: hs[i].tagName });
    }
    return out;
  }

  // True when the visible heading set actually turned over: a previous heading
  // left the document, or a heading node we've never seen appeared. Gates
  // chrome-marking so false swap candidates (a modal open paired with its
  // close by the churn carry) can't poison the chrome set.
  function headingsSwapped(prev, cur) {
    var i, j, found;
    for (i = 0; i < prev.length; i++) if (!inDoc(prev[i].el)) return true;
    for (i = 0; i < cur.length; i++) {
      for (j = 0, found = false; j < prev.length; j++) {
        if (prev[j].el === cur[i].el) { found = true; break; }
      }
      if (!found) return true;
    }
    return false;
  }

  // Headings that survive a content swap are persistent chrome; they must
  // never name a screen. Node identity only — text matching would falsely
  // mark content headings as chrome on keyed re-renders of identical content.
  function markChrome() {
    for (var i = 0; i < prevHeadings.length; i++) {
      if (inDoc(prevHeadings[i].el)) chromeNodes.add(prevHeadings[i].el);
    }
  }

  // Stride-sampled structural fingerprint of the whole body — sampling across
  // the full document (not the first N elements, which are usually all
  // header/nav chrome) so content differences register on chrome-heavy pages.
  function structuralFp() {
    var all = document.body ? document.body.getElementsByTagName('*') : [];
    var sigs = [];
    var i;
    var limit = all.length < 2000 ? all.length : 2000;
    for (i = 0; i < limit; i++) {
      if (!isVisible(all[i])) continue;
      sigs.push(all[i].tagName + '#' + (all[i].id || '') + '.' + ((all[i].classList && all[i].classList[0]) || '') + ';');
    }
    var step = Math.max(1, Math.floor(sigs.length / 40));
    var sig = '';
    for (i = 0; i < sigs.length; i += step) sig += sigs[i];
    return { fp: fnv(sig), seen: sigs.length };
  }

  // A stable, human-readable-when-possible name for what's on screen now.
  // Priority: explicit screen attributes (developer override) → the first
  // visible non-chrome heading (a chrome h1 falls through to content h2s) →
  // a structural fingerprint. `sparse` marks an effectively empty body (a SPA
  // wrapper before its app mounts) so it can be re-baselined instead of
  // counted as a screen of its own. `node` records which heading produced the
  // name so the baseline can be re-derived once chrome is identified.
  function deriveScreenName() {
    var i, el, v;
    var marked = document.querySelectorAll('[data-integral-screen],[data-page],[data-screen]');
    for (i = 0; i < marked.length; i++) {
      el = marked[i];
      if (!isVisible(el)) continue;
      v = el.getAttribute('data-integral-screen') || el.getAttribute('data-page') || el.getAttribute('data-screen');
      if (v) return { name: cleanName(v), sparse: false, node: null };
    }
    var lists = [document.querySelectorAll('h1'), document.querySelectorAll('h2')];
    for (var L = 0; L < lists.length; L++) {
      var heads = lists[L];
      for (i = 0; i < heads.length; i++) {
        el = heads[i];
        if (!isVisible(el) || chromeNodes.has(el) || inDialog(el)) continue;
        v = cleanName(el.textContent);
        if (v) return { name: v, sparse: false, node: el };
      }
    }
    var s = structuralFp();
    return { name: 's-' + s.fp, sparse: s.seen < 3, node: null };
  }

  // One-time: if the baseline was named by a heading that survives swaps (the
  // persistent site header), re-derive it from the first pre-swap heading that
  // was swapped OUT — h1 entries before h2, mirroring deriveScreenName's
  // priority — so returning to the first screen maps back to the bare route
  // key instead of forking a new '::' screen.
  function maybeRebaseName() {
    if (!domInfo || domInfo.rebased || !domInfo.node) return;
    if (!inDoc(domInfo.node)) { domInfo.rebased = true; return; } // content-named: nothing to fix
    var name = null;
    var i;
    for (i = 0; i < prevHeadings.length && !name; i++) {
      if (prevHeadings[i].tag === 'H1' && !inDoc(prevHeadings[i].el)) name = prevHeadings[i].text;
    }
    for (i = 0; i < prevHeadings.length && !name; i++) {
      if (prevHeadings[i].tag === 'H2' && !inDoc(prevHeadings[i].el)) name = prevHeadings[i].text;
    }
    if (name) domInfo = { name: name, sparse: false, node: null, rebased: true };
  }

  // ---- screen transitions ----

  // A 'nav' marker opens the new screen (the results view uses nav markers to
  // find a representative rrweb moment per screen).
  function commitScreen() {
    interactionBuf.push({
      kind: 'nav', x: 0, y: 0, page: currentScreen(),
      vw: window.innerWidth, vh: window.innerHeight, dh: docHeight(), at: Date.now(),
    });
  }

  // Pending scroll depth belongs to the screen being left, not the next one.
  function leaveScreen() {
    if (scrollTimer) {
      clearTimeout(scrollTimer);
      scrollTimer = null;
      interactionBuf.push({
        kind: 'scroll', x: 0, y: maxScroll, page: currentScreen(),
        vw: window.innerWidth, vh: window.innerHeight, dh: docHeight(), at: Date.now(),
      });
    }
    maxScroll = 0;
  }

  // Screen signals: reaching the designated screen latches the step. Re-run
  // on every route change so SPA route-based screen signals can fire mid-load.
  function checkScreenSignals() {
    var here = routeOrEntry();
    var sigs = signals();
    for (var i = 0; i < sigs.length; i++) {
      if (sigs[i].kind !== 'screen') continue;
      if (here !== sigs[i].screen.replace(/^\/+/, '')) continue;
      postHit(i, 'screen');
      if (i === sigs.length - 1) evalTerminal(i);
    }
  }

  function onRouteChange() {
    var r = computeRoute();
    if (r === ROUTE) return;
    leaveScreen();
    ROUTE = r;
    domPart = '';
    domInfo = null; // re-baseline once the new route renders
    suppressUntil = Date.now() + 600;
    commitScreen();
    checkScreenSignals();
    post('page', { page: ROUTE });
  }

  // DOM-swap detection: a burst of structural churn anywhere in the body that
  // both removes and adds substantial content (a replacement, not a modal or
  // toast) and leaves the page with a different derived name is a screen
  // change. Returns true when the churn was consumed (evaluated), false when
  // it should carry into the next debounce window (two-phase renders).
  function evalDomSwap(addedW, removedW) {
    var settling = domInfo === null || domInfo.sparse || Date.now() < suppressUntil;
    if (settling) {
      // Route render / app boot filling an empty shell: refresh the baseline
      // instead of treating the app's own first paint as a new screen. Total
      // churn here, not min — boot into an empty shell is add-only.
      if (addedW + removedW >= 2 || domInfo === null || domInfo.sparse) {
        var cs = snapshotHeadings();
        if (headingsSwapped(prevHeadings, cs)) markChrome(); // route settle: survivors are chrome
        domInfo = deriveScreenName();
        prevHeadings = cs;
      }
      return true;
    }
    // Replacement semantics: a modal/toast is add-only (and its close is
    // remove-only), so require churn on both sides.
    if ((addedW < removedW ? addedW : removedW) < 2) return false;
    var cur = snapshotHeadings();
    if (headingsSwapped(prevHeadings, cur)) {
      markChrome();
      maybeRebaseName();
    }
    var d = deriveScreenName();
    if (d.sparse) return false; // mid-teardown; let the carry pair it with the build
    prevHeadings = cur;
    var part = d.name === domInfo.name ? '' : d.name;
    if (part === domPart) return true;
    if (part && !domNames[part]) {
      if (domCount >= 16) return true; // runaway naming (dynamic headings) — stop splitting
      domNames[part] = true;
      domCount++;
    }
    leaveScreen();
    domPart = part;
    commitScreen();
    return true;
  }

  // Churn weight counts an added/removed element plus its whole subtree, so a
  // deep React swap (one container node, many descendants) registers even
  // though only one childList record fires.
  function subtreeWeight(node) {
    return 1 + node.getElementsByTagName('*').length;
  }

  function weighNodes(list) {
    var w = 0;
    for (var i = 0; i < list.length; i++) {
      if (list[i].nodeType === 1) w += subtreeWeight(list[i]);
    }
    return w;
  }

  // Two-phase renders (clear → spinner → fetch → build) split a swap's
  // removals and additions across debounce windows; carry unconsumed churn
  // forward briefly so the halves pair up.
  function churnGate(carry, addedW, removedW, now) {
    if (now > carry.until) { carry.a = 0; carry.r = 0; }
    return { a: addedW + carry.a, r: removedW + carry.r };
  }

  function churnSettle(carry, consumed, a, r, now) {
    if (consumed) { carry.a = 0; carry.r = 0; carry.until = 0; }
    else if (a + r >= 2) { carry.a = a; carry.r = r; carry.until = now + 4000; }
  }

  function observeDom() {
    if (!window.MutationObserver || !document.body) return;
    var pendingAdded = 0;
    var pendingRemoved = 0;
    var carry = { a: 0, r: 0, until: 0 };
    var domTimer = null;
    var mo = new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        if (records[i].type !== 'childList') continue;
        pendingAdded += weighNodes(records[i].addedNodes);
        pendingRemoved += weighNodes(records[i].removedNodes);
      }
      if (domTimer) clearTimeout(domTimer);
      domTimer = setTimeout(function () {
        domTimer = null;
        var now = Date.now();
        var g = churnGate(carry, pendingAdded, pendingRemoved, now);
        pendingAdded = 0;
        pendingRemoved = 0;
        churnSettle(carry, evalDomSwap(g.a, g.r), g.a, g.r, now);
      }, 250);
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  function trackRoutes() {
    if (window.history && history.pushState) {
      var origPush = history.pushState;
      var origReplace = history.replaceState;
      history.pushState = function () {
        var r = origPush.apply(this, arguments);
        onRouteChange();
        return r;
      };
      history.replaceState = function () {
        var r = origReplace.apply(this, arguments);
        onRouteChange();
        return r;
      };
    }
    window.addEventListener('popstate', onRouteChange);
    window.addEventListener('hashchange', onRouteChange);
  }

  function matchesUnmask(el) {
    if (!config || !config.unmaskSelectors) return false;
    for (var i = 0; i < config.unmaskSelectors.length; i++) {
      try {
        if (el.matches && el.matches(config.unmaskSelectors[i])) return true;
      } catch (e) { /* bad selector from dev config */ }
    }
    return false;
  }

  function start() {
    // Full replay stream: masked input content by default, but keystroke
    // *behavior* (timing, corrections) is preserved because masked values keep
    // their length.
    window.rrweb.record({
      emit: function (ev) { eventBuf.push(ev); },
      maskAllInputs: true,
      maskInputFn: function (text, el) {
        if (el && matchesUnmask(el)) return text;
        return '*'.repeat(text.length);
      },
      sampling: { mousemove: 50, scroll: 150 },
      recordCanvas: false,
    });

    // Interaction stream for heatmaps + junk filtering.
    document.addEventListener('click', function (e) {
      addInteraction('click', e.clientX + window.scrollX, e.clientY + window.scrollY);
      if (!e.target || !e.target.closest) return;
      var sigs = signals();
      for (var i = 0; i < sigs.length; i++) {
        if (sigs[i].kind !== 'click') continue;
        try {
          if (!e.target.closest(sigs[i].selector)) continue;
        } catch (err) { continue; /* invalid selector */ }
        postHit(i, 'click');
        if (i === sigs.length - 1) evalTerminal(i);
      }
    }, true);

    // Value signals: report every change on a watched field; the shell keeps
    // the latest value, and the terminal evaluation re-checks the live DOM.
    document.addEventListener('change', function (e) {
      if (!e.target || !e.target.closest) return;
      var sigs = signals();
      for (var i = 0; i < sigs.length; i++) {
        if (sigs[i].kind !== 'value') continue;
        var el = null;
        try { el = e.target.closest(sigs[i].selector); } catch (err) { continue; }
        if (!el) continue;
        postHit(i, 'value', readValue(el));
        if (i === sigs.length - 1) evalTerminal(i);
      }
    }, true);

    var lastMove = 0;
    document.addEventListener('mousemove', function (e) {
      var now = Date.now();
      if (now - lastMove < 120) return;
      lastMove = now;
      addInteraction('move', e.clientX + window.scrollX, e.clientY + window.scrollY);
    }, true);

    window.addEventListener('scroll', function () {
      var depth = window.scrollY + window.innerHeight;
      if (depth > maxScroll) maxScroll = depth;
      if (!scrollTimer) {
        scrollTimer = setTimeout(function () {
          scrollTimer = null;
          addInteraction('scroll', 0, maxScroll);
        }, 400);
      }
    }, true);

    // Keyboard *behavior* only — key category, never the key itself.
    document.addEventListener('keydown', function (e) {
      var cat = e.key === 'Backspace' || e.key === 'Delete' ? 2 : e.key === 'Enter' ? 3 : e.key.length === 1 ? 1 : 0;
      addInteraction('key', cat, 0);
    }, true);

    setInterval(flush, 1500);
    window.addEventListener('pagehide', flush);

    ROUTE = computeRoute(); // the app may have routed during boot, pre-patch
    domInfo = deriveScreenName();
    prevHeadings = snapshotHeadings();
    observeDom();
    trackRoutes();
    // Every page-load opens its screen with a nav marker; SPA transitions add
    // more via onRouteChange / evalDomSwap.
    commitScreen();
    checkScreenSignals();
    post('page', { page: ROUTE });
  }

  // Test hooks: pure helpers only, no recorder state.
  window.__integralInternals = {
    cleanName: cleanName,
    fnv: fnv,
    subtreeWeight: subtreeWeight,
    churnGate: churnGate,
    churnSettle: churnSettle,
    headingsSwapped: headingsSwapped,
  };

  // Handshake: ask the parent shell for config, then load rrweb and start.
  window.addEventListener('message', function (e) {
    if (e.origin !== ORIGIN || !e.data || !e.data.__integral) return;
    if (e.data.type === 'config' && !config) {
      config = e.data.config;
      var s = document.createElement('script');
      s.src = '/vendor/rrweb.js';
      s.onload = start;
      document.head.appendChild(s);
    }
  });
  post('hello', { page: computeRoute() });
})();
