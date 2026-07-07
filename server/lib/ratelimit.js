// In-memory per-IP rate limits — fine on a single process (deploy is one VPS,
// one node). Windows are generous for real use; the point is stopping scripted
// abuse of the anonymous surface, not throttling humans.
const { rateLimit } = require('express-rate-limit');

function limiter(windowMs, limit) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ error: 'rate_limited' }),
  });
}

module.exports = {
  // Artifact uploads: the expensive + abusable write path.
  uploadLimiter: limiter(60 * 60 * 1000, 60),
  // Anonymous session creation.
  sessionLimiter: limiter(60 * 1000, 60),
  // Event/interaction ingest (recorder flushes every ~2.5s per open session).
  ingestLimiter: limiter(60 * 1000, 600),
  // Abuse reports.
  reportLimiter: limiter(60 * 60 * 1000, 10),
};
