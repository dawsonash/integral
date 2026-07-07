// Success-signal chains. A test's success criteria is an ordered list of
// signals; the last one is the terminal action. Legacy rows (success_signals
// NULL) are synthesized into a one-signal chain here — the only place the old
// flat columns are interpreted — so every consumer sees the same array shape.
//
// Signal shapes:
//   { kind: 'click',  selector, label?, page? }
//   { kind: 'value',  selector, value, label?, page? }
//   { kind: 'screen', screen, label? }

function signalsFor(t) {
  if (t.success_signals) {
    try {
      const parsed = JSON.parse(t.success_signals);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    } catch (e) {
      /* fall through to legacy columns */
    }
  }
  if (t.success_type === 'screen' && t.success_screen) {
    return [{ kind: 'screen', screen: t.success_screen, label: 'reached ' + t.success_screen }];
  }
  if (t.success_selector) {
    return [{ kind: 'click', selector: t.success_selector, label: t.success_label || '' }];
  }
  return [];
}

const KINDS = ['click', 'value', 'screen'];

function isStr(v, max) {
  return typeof v === 'string' && v.length > 0 && v.length <= max;
}

// Returns an error message, or null if valid. Strips unknown keys in place.
function validateSignals(v) {
  if (!Array.isArray(v) || v.length < 1 || v.length > 20) {
    return 'success_signals must be an array of 1–20 signals.';
  }
  for (let i = 0; i < v.length; i++) {
    const s = v[i];
    if (!s || typeof s !== 'object' || !KINDS.includes(s.kind)) {
      return `signal ${i}: kind must be one of ${KINDS.join(', ')}.`;
    }
    if ((s.kind === 'click' || s.kind === 'value') && !isStr(s.selector, 500)) {
      return `signal ${i}: ${s.kind} signals need a selector.`;
    }
    if (s.kind === 'value' && !(typeof s.value === 'string' && s.value.length <= 500)) {
      return `signal ${i}: value signals need a string value.`;
    }
    if (s.kind === 'screen' && !isStr(s.screen, 500)) {
      return `signal ${i}: screen signals need a screen path.`;
    }
    if ('label' in s && !(typeof s.label === 'string' && s.label.length <= 120)) {
      return `signal ${i}: label must be a string of at most 120 chars.`;
    }
    if ('page' in s && !(typeof s.page === 'string' && s.page.length <= 500)) {
      return `signal ${i}: page must be a string of at most 500 chars.`;
    }
    for (const key of Object.keys(s)) {
      if (!['kind', 'selector', 'value', 'screen', 'label', 'page'].includes(key)) delete s[key];
    }
  }
  if (JSON.stringify(v).length > 8192) return 'success_signals too large (8 KB max).';
  return null;
}

module.exports = { signalsFor, validateSignals };
