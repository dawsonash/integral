// Daily retention sweep — the enforcement half of the plan retention windows
// and the free-tier link expiry, plus janitorial cleanup of orphaned files.
// No queue infra: index.js runs it on an interval, scripts/sweep.js runs it
// from cron. Tests never trigger it (app.js doesn't schedule it).
const fs = require('fs');
const path = require('path');
const { db, EVENTS_DIR, ARTIFACTS_DIR } = require('../db');
const { PLANS } = require('./plans');
const { deleteSessionRows } = require('./purge');

const DAY_MS = 24 * 60 * 60 * 1000;

function sweep(now = Date.now()) {
  const out = { expiredTests: 0, deletedSessions: 0, orphanEventFiles: 0, orphanArtifactDirs: 0 };

  // Ownerless tests (pre-auth rows) get free-tier treatment.
  const groups = db
    .prepare('SELECT id AS user_id, plan FROM users UNION ALL SELECT NULL, \'free\'')
    .all();

  for (const g of groups) {
    const plan = PLANS[g.plan] || PLANS.free;
    const ownerCond = g.user_id === null ? 'user_id IS NULL' : 'user_id = ?';
    const ownerArgs = g.user_id === null ? [] : [g.user_id];

    // Free links die linkTtlDays after launch (abuse friction + retention lever).
    if (plan.linkTtlDays) {
      out.expiredTests += db
        .prepare(
          `UPDATE tests SET status = 'closed'
           WHERE ${ownerCond} AND status = 'live' AND launched_at IS NOT NULL AND launched_at < ?`
        )
        .run(...ownerArgs, now - plan.linkTtlDays * DAY_MS).changes;
    }

    // Session data (rows + rrweb event files) past the retention window.
    if (Number.isFinite(plan.retentionDays)) {
      const ids = db
        .prepare(
          `SELECT s.id FROM sessions s JOIN tests t ON t.id = s.test_id
           WHERE t.${ownerCond} AND s.started_at < ?`
        )
        .all(...ownerArgs, now - plan.retentionDays * DAY_MS)
        .map((r) => r.id);
      deleteSessionRows(ids);
      out.deletedSessions += ids.length;
    }
  }

  // Orphaned event files (session row gone) and artifact dirs (test row gone).
  const sessionExists = db.prepare('SELECT 1 FROM sessions WHERE id = ?');
  for (const f of fs.readdirSync(EVENTS_DIR)) {
    if (f.endsWith('.jsonl') && !sessionExists.get(f.slice(0, -6))) {
      fs.rmSync(path.join(EVENTS_DIR, f), { force: true });
      out.orphanEventFiles++;
    }
  }
  const testExists = db.prepare('SELECT 1 FROM tests WHERE id = ?');
  for (const d of fs.readdirSync(ARTIFACTS_DIR)) {
    if (!testExists.get(d)) {
      fs.rmSync(path.join(ARTIFACTS_DIR, d), { recursive: true, force: true });
      out.orphanArtifactDirs++;
    }
  }
  return out;
}

module.exports = { sweep, DAY_MS };
