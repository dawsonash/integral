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

  // Current page path relative to the artifact root (/t/:id/app/<rel>).
  var m = location.pathname.match(/^\/t\/[^/]+\/app\/?(.*)$/);
  var PAGE = (m && m[1]) || '';

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
    post('signal', { index: index, kind: kind, value: value, page: PAGE, at: Date.now() });
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
    post('terminal', { index: index, page: PAGE, values: values, at: Date.now() });
  }

  function docHeight() {
    var b = document.body, e = document.documentElement;
    return Math.max(b ? b.scrollHeight : 0, e ? e.scrollHeight : 0, window.innerHeight);
  }

  function addInteraction(kind, x, y) {
    interactionBuf.push({
      kind: kind, x: x, y: y, page: PAGE || (config && config.entryPath) || '',
      vw: window.innerWidth, vh: window.innerHeight, dh: docHeight(), at: Date.now(),
    });
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

    var maxScroll = 0;
    var scrollTimer = null;
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

    // Screen signals: reaching the designated screen latches the step.
    var here = PAGE || config.entryPath || '';
    var sigs = signals();
    for (var i = 0; i < sigs.length; i++) {
      if (sigs[i].kind !== 'screen') continue;
      if (here !== sigs[i].screen.replace(/^\/+/, '')) continue;
      postHit(i, 'screen');
      if (i === sigs.length - 1) evalTerminal(i);
    }
    post('page', { page: PAGE });
  }

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
  post('hello', { page: PAGE });
})();
