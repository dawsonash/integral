// Plan limits gate the three axes the spec chose (§8): volume (active tests +
// responses/month), retention, and — from the abuse side — artifact size.
// 'unlimited' is internal: dev-mode logins and hand-granted comp accounts.
const PLANS = {
  free: {
    label: 'Free',
    activeTests: 1,
    responsesPerMonth: 25,
    retentionDays: 14,
    artifactBytes: 10 * 1024 * 1024,
    linkTtlDays: 14, // live links auto-expire
  },
  pro: {
    label: 'Pro',
    activeTests: 10,
    responsesPerMonth: 500,
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

function planFor(user) {
  return PLANS[user && user.plan] || PLANS.free;
}

function monthStart(now = Date.now()) {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

module.exports = { PLANS, planFor, monthStart };
