const app = require('./app');
const { sweep } = require('./lib/retention');

const PORT = Number(process.env.PORT || 4000);
// Unset binds everywhere, which is what local dev wants. Production sets
// 127.0.0.2 so the sandbox's cgroup address filter can allow 127.0.0.1 — the
// ephemeral Postgres and the stub proxy — without also handing a sandboxed app
// a route to this API. See server/lib/sandbox/confine.js and deploy/Caddyfile.
const BIND_HOST = process.env.INTEGRAL_BIND_HOST || undefined;
app.listen(PORT, BIND_HOST, () => {
  console.log(`Integral running at http://${BIND_HOST || 'localhost'}:${PORT}`);
});

// Daily retention sweep (plan retention windows, free link expiry, orphaned
// files). scripts/sweep.js runs the same thing from cron if you prefer.
setInterval(() => {
  try {
    const r = sweep();
    if (r.expiredTests || r.deletedSessions || r.orphanEventFiles || r.orphanArtifactDirs) {
      console.log('[retention]', JSON.stringify(r));
    }
  } catch (e) {
    console.error('[retention] sweep failed:', e.message);
  }
}, 24 * 60 * 60 * 1000).unref();

// Sandboxed apps are detached child processes with throwaway databases —
// they must not outlive the server.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    try {
      await require('./lib/sandbox/registry').teardownAll();
    } catch (e) { /* best effort */ }
    process.exit(0);
  });
}
