// Plan limits gate the three axes the spec chose (§8): volume (active tests +
// responses/month), retention, and — from the abuse side — artifact size.
// 'unlimited' is internal: dev-mode logins and hand-granted comp accounts.
//
// Team is the one plan whose limits aren't fixed: its volume axes are pooled
// across the workspace and scale with the number of members, which is what the
// per-seat charge buys. See lib/teams.js for the membership model.
const { teamForUser, memberCount } = require('./teams');

const PAID_VOLUME = { activeTests: 10, responsesPerMonth: 500 };
// Every paid plan keeps data for the same year; only the free tier differs.
const PAID_RETENTION_DAYS = 365;

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
    retentionDays: PAID_RETENTION_DAYS,
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
    retentionDays: PAID_RETENTION_DAYS,
    artifactBytes: 50 * 1024 * 1024,
    linkTtlDays: null,
  },
  unlimited: {
    label: 'Unlimited',
    activeTests: Infinity,
    responsesPerMonth: Infinity,
    retentionDays: PAID_RETENTION_DAYS,
    artifactBytes: 50 * 1024 * 1024,
    linkTtlDays: null,
  },
};

// When a paid plan lapses, its data keeps the paid retention window for this
// long before dropping to the free one. Volume limits tighten immediately —
// that's the pricing lever — but deleting research the day a card expires isn't
// a lever, it's data loss. The grace window is the runway to notice and fix the
// card. Teams and individuals get the same runway; a team's is just louder,
// because the people who lose the data mostly aren't the one who was billed.
const RETENTION_GRACE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

// Paid keys, i.e. the plans a lapse can fall *from*. 'unlimited' isn't here:
// it's the internal comp grant and never lapses through billing.
const PAID_PLANS = new Set(['individual', 'pro']);

// The retention axes that apply during that runway: the paid window, and link
// expiry still off so nothing gets silently closed mid-grace. Only the
// retention fields are read here — volume is enforced live by planFor().
const GRACE_RETENTION = {
  label: 'Grace',
  retentionDays: PAID_RETENTION_DAYS,
  linkTtlDays: null,
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
    retentionDays: PAID_RETENTION_DAYS,
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

// When data whose plan lapsed at `lapsedAt` actually loses the paid retention
// window. Null once the grace has already run out — at that point there's
// nothing left to warn anyone about.
function graceEndsAt(lapsedAt, now = Date.now()) {
  if (!lapsedAt) return null;
  const ends = lapsedAt + RETENTION_GRACE_DAYS * DAY_MS;
  return ends > now ? ends : null;
}

// The deadline that applies to *this user's* data: their team's clock if
// they're in one, their own otherwise — the same split scopeFor() makes. Null
// while the plan is current, so callers can treat it as "is anything lapsing".
function graceFor(user, now = Date.now()) {
  if (!user) return null;
  const team = teamForUser(user.id);
  if (team) return team.plan === 'team' ? null : graceEndsAt(team.plan_lapsed_at, now);
  return PAID_PLANS.has(user.plan) || user.plan === 'unlimited'
    ? null
    : graceEndsAt(user.plan_lapsed_at, now);
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

module.exports = {
  PLANS, PAID_VOLUME, PAID_RETENTION_DAYS, PAID_PLANS,
  RETENTION_GRACE_DAYS, GRACE_RETENTION, graceEndsAt, graceFor,
  teamPlan, planFor, scopeFor, monthStart,
};
