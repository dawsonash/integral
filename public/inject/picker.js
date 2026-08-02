// Integral element picker — injected into artifact screens in setup/preview
// mode. Lets the dev point-and-click the success target; infers a stable CSS
// selector and reports it to the parent setup page.
(function () {
  'use strict';
  if (window.__integralPicker) return;
  window.__integralPicker = true;
  if (window.top === window) return;

  // Origin of the setup page framing us. Under the origin split that is NOT
  // our own origin (we're served by the run host, setup lives on the
  // dashboard), and postMessage silently discards a message whose target
  // origin doesn't match the recipient — so every step would vanish. The
  // server stamps the right value onto our own <script> tag.
  var tag = document.currentScript || document.querySelector('script[data-setup-origin]');
  var PARENT = (tag && tag.getAttribute('data-setup-origin')) || location.origin;
  var mode = 'pick'; // 'pick' | 'browse'
  var hovered = null;

  var m = location.pathname.match(/^\/t\/[^/]+\/preview\/?(.*)$/);
  var PAGE = (m && m[1]) || '';

  var style = document.createElement('style');
  style.textContent =
    '.__integral-hover{outline:2px solid #6366f1 !important;outline-offset:1px;cursor:crosshair !important;}';
  document.head.appendChild(style);

  function post(type, payload) {
    window.parent.postMessage(Object.assign({ __integral: true, type: type }, payload), PARENT);
  }

  function esc(s) {
    return window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/([^a-zA-Z0-9_-])/g, '\\$1');
  }

  function unique(sel) {
    try {
      return document.querySelectorAll(sel).length === 1;
    } catch (e) {
      return false;
    }
  }

  // Prefer id, then data-testid — on the element or a near ancestor, since
  // clicks land on inner text/icon nodes of the actionable element. Safe to
  // generalize upward: the recorder matches clicks with closest(selector).
  function inferSelector(el) {
    var node = el;
    for (var depth = 0; node && node.nodeType === 1 && node !== document.body && depth < 5; depth++) {
      if (node.id && unique('#' + esc(node.id))) return '#' + esc(node.id);
      if (node.dataset && node.dataset.testid) {
        var s = '[data-testid="' + node.dataset.testid + '"]';
        if (unique(s)) return s;
      }
      node = node.parentNode;
    }
    var parts = [];
    node = el;
    while (node && node.nodeType === 1 && node !== document.body) {
      var part = node.tagName.toLowerCase();
      if (node.id) {
        parts.unshift('#' + esc(node.id));
        break;
      }
      var siblings = Array.prototype.filter.call(
        node.parentNode ? node.parentNode.children : [],
        function (c) { return c.tagName === node.tagName; }
      );
      if (siblings.length > 1) {
        part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = node.parentNode;
      var candidate = parts.join(' > ');
      if (unique(candidate)) return candidate;
    }
    return parts.join(' > ');
  }

  function labelFor(el) {
    var text = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 60);
    return text || '<' + el.tagName.toLowerCase() + '>';
  }

  document.addEventListener('mouseover', function (e) {
    if (mode !== 'pick') return;
    if (hovered) hovered.classList.remove('__integral-hover');
    hovered = e.target;
    hovered.classList.add('__integral-hover');
  }, true);

  function readValue(el) {
    // Must mirror the recorder's convention exactly.
    if (el.type === 'checkbox') return el.checked ? 'true' : 'false';
    return String(el.value == null ? '' : el.value);
  }

  function shownValue(el) {
    if (el.tagName === 'SELECT' && el.selectedIndex >= 0) {
      return el.options[el.selectedIndex].text.trim().slice(0, 40);
    }
    return readValue(el).slice(0, 40);
  }

  // labelFor(select) would concatenate every option's text; prefer the
  // field's <label>, then name/placeholder.
  function fieldName(el) {
    if (el.id) {
      var lab = document.querySelector('label[for="' + esc(el.id) + '"]');
      if (lab && lab.innerText.trim()) return lab.innerText.trim().slice(0, 40);
    }
    return el.name || el.placeholder || '<' + el.tagName.toLowerCase() + '>';
  }

  var FORM_TAGS = ['SELECT', 'INPUT', 'TEXTAREA', 'OPTION'];

  // Record-by-demonstration: clicks are NOT prevented — the dev drives the
  // artifact for real (navigation, DOM swaps) and each action becomes a step.
  document.addEventListener('click', function (e) {
    if (mode !== 'pick') return;
    var el = e.target;
    el.classList.remove('__integral-hover');
    // Clicking a form control just operates it; its `change` makes the step.
    if (FORM_TAGS.indexOf(el.tagName) !== -1) return;
    post('picked', { kind: 'click', selector: inferSelector(el), label: labelFor(el), page: PAGE });
  }, true);

  // Changing a field records a value step: "this field must equal this value".
  document.addEventListener('change', function (e) {
    if (mode !== 'pick') return;
    var el = e.target;
    if (FORM_TAGS.indexOf(el.tagName) === -1) return;
    post('picked', {
      kind: 'value',
      selector: inferSelector(el),
      value: readValue(el),
      label: fieldName(el) + ' = ' + shownValue(el),
      page: PAGE,
    });
  }, true);

  document.addEventListener('submit', function (e) {
    if (mode === 'pick') e.preventDefault();
  }, true);

  window.addEventListener('message', function (e) {
    if (e.origin !== PARENT || !e.data || !e.data.__integral) return;
    if (e.data.type === 'mode') {
      mode = e.data.mode;
      if (mode !== 'pick' && hovered) hovered.classList.remove('__integral-hover');
      document.body.style.cursor = '';
    }
  });

  post('pickerReady', { page: PAGE });
})();
