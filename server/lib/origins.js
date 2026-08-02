// The two origins the origin split (server/app.js) creates: the dashboard, and
// the run host that serves hosted artifacts. Anything that talks *across* the
// two needs both by name — postMessage takes an explicit target origin, and a
// browser drops a message aimed at the wrong one without so much as a console
// warning. Today that's the setup page and the element picker it embeds.
//
// With no INTEGRAL_RUN_HOST (dev, and the test suite) both collapse to the
// request's own origin, which is why same-origin code paths never noticed.

// Public URL of the dashboard. Must come from config, not the request: the
// picker is served *by the run host*, so its request carries the wrong Host.
function appOrigin(req) {
  const configured = process.env.INTEGRAL_APP_URL;
  if (configured) return configured.replace(/\/+$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

// Origin serving /t/ and /p/ — where an artifact iframe actually ends up.
function runOrigin(req) {
  const host = process.env.INTEGRAL_RUN_HOST;
  if (!host) return `${req.protocol}://${req.get('host')}`;
  // The run host is this same listener under a second name, so it answers on
  // the same port. Implicit in production (443), but carrying it matters when
  // developing against the split on :4000 — an origin that drops the port is a
  // different origin, and postMessage would go back to failing silently.
  const port = (req.get('host') || '').split(':')[1];
  return `${req.protocol}://${host}${port ? ':' + port : ''}`;
}

module.exports = { appOrigin, runOrigin };
