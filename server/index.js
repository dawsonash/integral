const app = require('./app');
const { sweep } = require('./lib/retention');

const PORT = Number(process.env.PORT || 4000);
app.listen(PORT, () => {
  console.log(`Integral running at http://localhost:${PORT}`);
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
