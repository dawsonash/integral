// Daily retention sweep — the enforcement half of the plan retention windows
// and the free-tier link expiry, plus janitorial cleanup of orphaned files.
// No queue infra: index.js runs it on an interval, scripts/sweep.js runs it
// from cron. Tests never trigger it (app.js doesn't schedule it).
const fs = require('fs');
const path = require('path');
const { db, EVENTS_DIR, ARTIFACTS_DIR } = require('../db');
const { PLANS, teamPlan } = require('./plans');
const { memberCount } = require('./teams');
const { deleteSessionRows } = require('./purge');

const DAY_MS = 24 * 60 * 60 * 1000;

// One group per allowance pool, because retention is a property of the plan
// paying for the data. A team's tests are swept under the team's plan even
// though each row still records the individual who made it; personal tests are
// swept under their owner's plan; ownerless (pre-auth) rows get free tier.
function retentionGroups() {
  const groups = [];
  for (const team of db.prepare('SELECT id, plan FROM teams').all()) {
    groups.push({
      plan: team.plan === 'team' ? teamPlan(memberCount(team.id)) : PLANS.free,
      cond: (a) => `${a}team_id = ?`,
      args: [team.id],
    });
  }
  // Anyone not in a team: their rows are the ones with no team_id.
  for (const u of db.prepare('SELECT id, plan FROM users WHERE id NOT IN (SELECT user_id FROM team_members)').all()) {
    groups.push({
      plan: PLANS[u.plan] || PLANS.free,
      cond: (a) => `${a}user_id = ? AND ${a}team_id IS NULL`,
      args: [u.id],
    });
  }
  groups.push({ plan: PLANS.free, cond: (a) => `${a}user_id IS NULL`, args: [] });
  return groups;
}

function sweep(now = Date.now()) {
  const out = { expiredTests: 0, deletedSessions: 0, orphanEventFiles: 0, orphanArtifactDirs: 0 };

  for (const g of retentionGroups()) {
    const plan = g.plan;
    const ownerArgs = g.args;

    // Free links die linkTtlDays after launch (abuse friction + retention lever).
    if (plan.linkTtlDays) {
      out.expiredTests += db
        .prepare(
          `UPDATE tests SET status = 'closed'
           WHERE ${g.cond('')} AND status = 'live' AND launched_at IS NOT NULL AND launched_at < ?`
        )
        .run(...ownerArgs, now - plan.linkTtlDays * DAY_MS).changes;
    }

    // Session data (rows + rrweb event files) past the retention window.
    if (Number.isFinite(plan.retentionDays)) {
      const ids = db
        .prepare(
          `SELECT s.id FROM sessions s JOIN tests t ON t.id = s.test_id
           WHERE ${g.cond('t.')} AND s.started_at < ?`
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
      // Per-dir try/catch: a sandbox writes into its artifact dir as a
      // different uid, so one unremovable subtree (EPERM — which `force` does
      // not swallow, unlike ENOENT) must not abort the whole sweep.
      try {
        fs.rmSync(path.join(ARTIFACTS_DIR, d), { recursive: true, force: true });
        out.orphanArtifactDirs++;
      } catch (e) {
        console.error(`[retention] could not remove artifact dir ${d}: ${e.message}`);
      }
    }
  }
  return out;
}

module.exports = { sweep, DAY_MS };
