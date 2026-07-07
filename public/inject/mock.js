// Sandbox API mocks. Injected into artifact <head> ahead of the page's own
// scripts; answers matching fetch/XHR requests with the developer's hardcoded
// responses so pages that need a backend still work in the sandbox.
(function () {
  'use strict';
  var mocks = window.__INTEGRAL_MOCKS__ || [];
  if (!mocks.length) return;

  function resolved(url) {
    try { return new URL(url, location.href); } catch (e) { return null; }
  }

  // A rule URL matches the request's full URL or its path (query ignored on
  // the rule side unless it has one). A trailing * makes it a prefix match.
  function findMock(method, url) {
    var u = resolved(url);
    var full = u ? u.href : String(url);
    var pathOnly = u ? u.pathname : String(url);
    var pathQuery = u ? u.pathname + u.search : String(url);
    for (var i = 0; i < mocks.length; i++) {
      var m = mocks[i];
      if (m.method && m.method !== 'ANY' && m.method !== method) continue;
      var t = m.url;
      var hit;
      if (t.charAt(t.length - 1) === '*') {
        var prefix = t.slice(0, -1);
        hit = full.indexOf(prefix) === 0 || pathQuery.indexOf(prefix) === 0;
      } else {
        hit = full === t || pathQuery === t || pathOnly === t;
      }
      if (hit) return m;
    }
    return null;
  }

  function contentType(body) {
    try { JSON.parse(body); return 'application/json'; } catch (e) { return 'text/plain; charset=utf-8'; }
  }

  // ---- fetch ----
  var realFetch = window.fetch;
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || String(input);
    var method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    var m = findMock(method, url);
    if (!m) return realFetch.apply(this, arguments);
    var body = m.body || '';
    return Promise.resolve(new Response(body, {
      status: m.status || 200,
      headers: { 'Content-Type': contentType(body) },
    }));
  };

  // ---- XMLHttpRequest ----
  var proto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
  if (!proto) return;
  var realOpen = proto.open;
  var realSend = proto.send;
  proto.open = function (method, url) {
    this.__integralMock = findMock(String(method).toUpperCase(), url);
    return realOpen.apply(this, arguments);
  };
  proto.send = function () {
    var m = this.__integralMock;
    if (!m) return realSend.apply(this, arguments);
    var xhr = this;
    var body = m.body || '';
    setTimeout(function () {
      Object.defineProperty(xhr, 'readyState', { value: 4, configurable: true });
      Object.defineProperty(xhr, 'status', { value: m.status || 200, configurable: true });
      Object.defineProperty(xhr, 'statusText', { value: '', configurable: true });
      Object.defineProperty(xhr, 'responseText', { value: body, configurable: true });
      Object.defineProperty(xhr, 'response', {
        value: xhr.responseType === 'json' ? safeJson(body) : body,
        configurable: true,
      });
      Object.defineProperty(xhr, 'getAllResponseHeaders', {
        value: function () { return 'content-type: ' + contentType(body) + '\r\n'; },
        configurable: true,
      });
      Object.defineProperty(xhr, 'getResponseHeader', {
        value: function (h) { return /^content-type$/i.test(h) ? contentType(body) : null; },
        configurable: true,
      });
      // dispatchEvent also invokes the on* property handlers.
      xhr.dispatchEvent(new Event('readystatechange'));
      xhr.dispatchEvent(new Event('load'));
      xhr.dispatchEvent(new Event('loadend'));
    }, 0);
  };

  function safeJson(s) {
    try { return JSON.parse(s); } catch (e) { return null; }
  }
})();
