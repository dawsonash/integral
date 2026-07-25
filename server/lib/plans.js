// Plan limits gate the three axes the spec chose (§8): volume (active tests +
// responses/month), retention, and — from the abuse side — artifact size.
// 'unlimited' is internal: dev-mode logins and hand-granted comp accounts.
//
// Team is the one plan whose limits aren't fixed: its volume axes are pooled
// across the workspace and scale with the number of members, which is what the
// per-seat charge buys. See lib/teams.js for the membership model.
const { teamForUser, memberCount } = require('./teams');

const PAID_VOLUME = { activeTests: 10, responsesPerMonth: 500 };

const PLANS = {
  free: {
    label: 'Free',
    activeTests: 1,
    responsesPerMonth: 25,
    retentionDays: 14,
    artifactBytes: 10 * 1024 * 1024,
    linkTtlDays: 14, // live links auto-expire
  },
  individual: {
    label: 'Individual',
    activeTests: PAID_VOLUME.activeTests,
    responsesPerMonth: PAID_VOLUME.responsesPerMonth,
    retentionDays: 365,
    artifactBytes: 50 * 1024 * 1024,
    linkTtlDays: null,
  },
  // Legacy: everyone who subscribed at $29 before the Individual/Team split.
  // Same entitlements as Individual, kept as its own key so existing rows,
  // webhooks, and dev logins keep resolving.
  pro: {
    label: 'Pro',
    activeTests: PAID_VOLUME.activeTests,
    responsesPerMonth: PAID_VOLUME.responsesPerMonth,
    retentionDays: 365,
    artifactBytes: 50 * 1024 * 1024,
    linkTtlDays: null,
  },
  unlimited: {
    label: 'Unlimited',
    activeTests: Infinity,
    responsesPerMonth: Infinity,
    retentionDays: 365,
    artifactBytes: 50 * 1024 * 1024,
    linkTtlDays: null,
  },
};

// Pooled team limits for a given headcount. One seat lands exactly on the
// Individual allowance; each teammate adds another whole allowance to the pool.
function teamPlan(seats) {
  const n = Math.max(1, seats);
  return {
    label: 'Team',
    seats: n,
    activeTests: PAID_VOLUME.activeTests * n,
    responsesPerMonth: PAID_VOLUME.responsesPerMonth * n,
    retentionDays: 365,
    artifactBytes: 50 * 1024 * 1024,
    linkTtlDays: null,
  };
}

// A paid team overrides the member's personal plan — that's the entitlement
// they're being billed for. 'unlimited' still wins, since it's the internal
// comp/dev grant and must never be downgraded by team state.
function planFor(user) {
  if (!user) return PLANS.free;
  if (user.plan === 'unlimited') return PLANS.unlimited;
  const team = teamForUser(user.id);
  if (team && team.plan === 'team') return teamPlan(memberCount(team.id));
  return PLANS[user.plan] || PLANS.free;
}

// Where a user's tests live. Team members share one pool keyed on team_id;
// everyone else owns their rows personally. Callers interpolate `where` into
// queries over the `tests` table aliased as `alias`.
function scopeFor(user, alias = 't') {
  const team = user ? teamForUser(user.id) : null;
  if (team) return { where: `${alias}.team_id = ?`, args: [team.id], teamId: team.id };
  return { where: `${alias}.user_id = ?`, args: [user.id], teamId: null };
}

function monthStart(now = Date.now()) {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

module.exports = { PLANS, PAID_VOLUME, teamPlan, planFor, scopeFor, monthStart };
