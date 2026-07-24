// Screen-key normalization for heatmap aggregation. Interactions arrive with
// concrete screen keys ("event/123", "index.html::Checkout"); the results
// view wants one heatmap bucket per *template* ("event/{id}"), so dynamic
// path segments are collapsed at query time. Keys have the shape
// `<route>` or `<route>::<domName>`; only the route part is normalized —
// the DOM-screen name after `::` is already a stable label.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_RE = /^[0-9a-f]{12,}$/i;
const TOKEN_RE = /^[A-Za-z0-9_-]{16,}$/;

// True for segments that look like row ids rather than route words. Plain
// words ("search", "login"), versions ("v2"), and filenames ("index.html")
// must survive untouched.
function isDynamicSegment(seg) {
  if (/^\d+$/.test(seg)) return true;
  if (UUID_RE.test(seg)) return true;
  if (HEX_RE.test(seg)) return true;
  if (TOKEN_RE.test(seg) && (seg.match(/\d/g) || []).length >= 2) return true;
  return false;
}

function normalizePage(page) {
  const s = String(page);
  const sep = s.indexOf('::');
  const route = sep === -1 ? s : s.slice(0, sep);
  const dom = sep === -1 ? '' : s.slice(sep);
  const norm = route
    .split('/')
    .map((seg) => (isDynamicSegment(seg) ? '{id}' : seg))
    .join('/');
  return norm + dom;
}

// rows: [{ page, count }] with concrete pages → grouped buckets keyed by the
// normalized page. representative = the concrete page with the most
// interactions in its group (used to pick a snapshot / label a background).
function groupPages(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = normalizePage(r.page);
    let g = groups.get(key);
    if (!g) {
      g = { key, count: 0, representative: r.page, repCount: 0, concretes: [] };
      groups.set(key, g);
    }
    g.count += r.count;
    g.concretes.push(r.page);
    if (r.count > g.repCount) {
      g.repCount = r.count;
      g.representative = r.page;
    }
  }
  return [...groups.values()].map(({ repCount, ...g }) => g);
}

module.exports = { isDynamicSegment, normalizePage, groupPages };
