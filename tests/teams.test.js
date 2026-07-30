// Team plan: shared workspace + per-seat billing. Covers the two things the
// pricing actually promises — that members really do share one pool of tests,
// and that the pool's size tracks headcount — plus the roster lifecycle
// (invite, join, leave) that drives the Stripe seat quantity.
//
// Teams are created through lib/teams here rather than through Checkout: the
// HTTP path to a team runs through Stripe, which isn't configured in tests.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.INTEGRAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'integral-teams-'));

const app = require('../server/app');
const { db } = require('../server/db');
const teams = require('../server/lib/teams');
const { planFor, PLANS, RETENTION_GRACE_DAYS } = require('../server/lib/plans');
const { sweep, DAY_MS } = require('../server/lib/retention');
const { setTeamPlan } = require('../server/routes/billing');

let server;
let base;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://localhost:${server.address().port}`;
      resolve();
    });
  });
});

after(() => {
  server.close();
  fs.rmSync(process.env.INTEGRAL_DATA_DIR, { recursive: true, force: true });
});

async function login(name, plan) {
  const res = await fetch(`${base}/auth/dev?login=${name}${plan ? `&plan=${plan}` : ''}`, {
    headers: { Accept: 'application/json' },
    redirect: 'manual',
  });
  return res.headers.getSetCookie()[0].split(';')[0];
}

async function api(method, p, body, cookie) {
  const res = await fetch(base + p, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), Cookie: cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function createTest(name, cookie) {
  const fd = new FormData();
  fd.append('name', name);
  fd.append('html', '<!DOCTYPE html><html><body><button id="buy">Buy</button></body></html>');
  const res = await fetch(base + '/api/tests', { method: 'POST', body: fd, headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  return res.json();
}

function userByLogin(login) {
  return db.prepare('SELECT * FROM users WHERE login = ?').get(login);
}

// A paid team, the way the webhook leaves it after Checkout completes.
function paidTeam(ownerId, name, interval = 'month') {
  const team = teams.createTeam(ownerId, name, interval);
  db.prepare("UPDATE teams SET plan = 'team', stripe_subscription_id = 'sub_test' WHERE id = ?").run(team.id);
  return teams.teamById.get(team.id);
}

test('creating a team sweeps the founder\'s existing tests into it', async () => {
  const cookie = await login('founder', 'free');
  const me = userByLogin('founder');
  const t = await createTest('pre-existing', cookie);
  assert.equal(db.prepare('SELECT team_id FROM tests WHERE id = ?').get(t.id).team_id, null);

  const team = paidTeam(me.id, 'Platform');
  assert.equal(db.prepare('SELECT team_id FROM tests WHERE id = ?').get(t.id).team_id, team.id);
});

test('paid team pools limits and scales them per seat', async () => {
  const cookie = await login('scaleowner', 'free');
  const owner = userByLogin('scaleowner');
  const team = paidTeam(owner.id, 'Scale');

  // Solo team: exactly the Individual allowance, and nothing billable yet.
  let plan = planFor(userByLogin('scaleowner'));
  assert.equal(plan.label, 'Team');
  assert.equal(plan.activeTests, PLANS.individual.activeTests);
  assert.equal(plan.responsesPerMonth, PLANS.individual.responsesPerMonth);
  assert.equal(teams.billableSeats(team.id), 0);

  // Two teammates: three seats of allowance, two of them billable.
  await login('scalemate1', 'free');
  await login('scalemate2', 'free');
  for (const name of ['scalemate1', 'scalemate2']) {
    const invite = teams.createInvite(team.id, name, owner.id);
    teams.acceptInvite(invite, userByLogin(name));
  }
  plan = planFor(userByLogin('scaleowner'));
  assert.equal(plan.seats, 3);
  assert.equal(plan.activeTests, PLANS.individual.activeTests * 3);
  assert.equal(plan.responsesPerMonth, PLANS.individual.responsesPerMonth * 3);
  assert.equal(teams.billableSeats(team.id), 2);

  // A member's own free users.plan row must not override what the team bought.
  assert.equal(planFor(userByLogin('scalemate1')).label, 'Team');
  assert.equal(planFor(userByLogin('scalemate1')).activeTests, PLANS.individual.activeTests * 3);
});

test('members share one test pool; outsiders still get 404', async () => {
  const ownerCookie = await login('shareowner', 'free');
  const owner = userByLogin('shareowner');
  const team = paidTeam(owner.id, 'Sharing');

  const mateCookie = await login('sharemate', 'free');
  const invite = teams.createInvite(team.id, 'sharemate', owner.id);
  teams.acceptInvite(invite, userByLogin('sharemate'));

  const ownerTest = await createTest('owner-made', ownerCookie);
  const mateTest = await createTest('mate-made', mateCookie);

  // Both people see both tests, tagged with who made each.
  for (const cookie of [ownerCookie, mateCookie]) {
    const { json } = await api('GET', '/api/tests', null, cookie);
    const names = json.map((t) => t.name).sort();
    assert.deepEqual(names, ['mate-made', 'owner-made']);
    assert.deepEqual(json.map((t) => t.author).sort(), ['shareowner', 'sharemate'].sort());
  }

  // Each can open the other's test and its results.
  assert.equal((await api('GET', `/api/tests/${mateTest.id}`, null, ownerCookie)).status, 200);
  assert.equal((await api('GET', `/api/tests/${ownerTest.id}/results`, null, mateCookie)).status, 200);

  // Someone outside the team sees none of it.
  const outsider = await login('outsider', 'free');
  assert.equal((await api('GET', `/api/tests/${ownerTest.id}`, null, outsider)).status, 404);
  assert.deepEqual((await api('GET', '/api/tests', null, outsider)).json, []);
});

test('invite → join → leave over HTTP, with ownership transfer on the way out', async () => {
  const ownerCookie = await login('flowowner', 'free');
  const owner = userByLogin('flowowner');
  const team = paidTeam(owner.id, 'Flow');

  // Only the owner may invite.
  const mateCookie = await login('flowmate', 'free');
  assert.equal((await api('POST', '/api/team/invites', { invitee: 'x' }, mateCookie)).status, 404);

  const created = await api('POST', '/api/team/invites', { invitee: 'flowmate' }, ownerCookie);
  assert.equal(created.status, 200);
  const token = created.json.invite.token;
  assert.match(created.json.invite.url, /\/join\//);

  // An invite is bound to the person it names.
  const wrongCookie = await login('wrongperson', 'free');
  const wrong = await api('POST', `/api/team/join/${token}`, null, wrongCookie);
  assert.equal(wrong.status, 403);

  assert.equal((await api('POST', `/api/team/join/${token}`, null, mateCookie)).status, 200);
  assert.equal(teams.memberCount(team.id), 2);
  assert.equal(teams.billableSeats(team.id), 1);

  // Reusing a spent invite fails.
  assert.equal((await api('POST', `/api/team/join/${token}`, null, mateCookie)).status, 404);

  // Work the teammate did inside the team stays with the team when they go.
  const mateTest = await createTest('mate-research', mateCookie);
  const mate = userByLogin('flowmate');
  assert.equal((await api('DELETE', `/api/team/members/${mate.id}`, null, mateCookie)).status, 200);

  const row = db.prepare('SELECT user_id, team_id FROM tests WHERE id = ?').get(mateTest.id);
  assert.equal(row.team_id, team.id, 'test stays in the team');
  assert.equal(row.user_id, owner.id, 'ownership transfers to the team owner');
  assert.equal(teams.memberCount(team.id), 1);
  assert.equal(teams.billableSeats(team.id), 0);

  // And the departed member is back to their own free workspace.
  assert.equal(planFor(userByLogin('flowmate')).label, 'Free');
  assert.deepEqual((await api('GET', '/api/tests', null, mateCookie)).json, []);
});

test('the owner cannot leave, and only the owner can remove others', async () => {
  const ownerCookie = await login('lastowner', 'free');
  const owner = userByLogin('lastowner');
  const team = paidTeam(owner.id, 'Last');
  const mateCookie = await login('lastmate', 'free');
  teams.acceptInvite(teams.createInvite(team.id, 'lastmate', owner.id), userByLogin('lastmate'));

  const self = await api('DELETE', `/api/team/members/${owner.id}`, null, ownerCookie);
  assert.equal(self.status, 400);
  assert.equal(self.json.error, 'owner_cannot_leave');

  // A member aiming at the owner is stopped by the permission check first.
  const mate = userByLogin('lastmate');
  assert.equal((await api('DELETE', `/api/team/members/${owner.id}`, null, mateCookie)).status, 403);
  // But they can always remove themselves — that's "leave team".
  assert.equal((await api('DELETE', `/api/team/members/${mate.id}`, null, mateCookie)).status, 200);
});

test('an owner can hand the team to a member, and then leave', async () => {
  const ownerCookie = await login('handoff', 'free');
  const owner = userByLogin('handoff');
  const team = paidTeam(owner.id, 'Handoff');
  const heirCookie = await login('heir', 'free');
  teams.acceptInvite(teams.createInvite(team.id, 'heir', owner.id), userByLogin('heir'));
  const heir = userByLogin('heir');

  // A member can't hand the team to themselves.
  assert.equal((await api('POST', '/api/team/owner', { userId: heir.id }, heirCookie)).status, 403);
  // Nor can the owner hand it to somebody outside the roster.
  const outsiderCookie = await login('handoffoutsider', 'free');
  const outsider = userByLogin('handoffoutsider');
  assert.equal((await api('POST', '/api/team/owner', { userId: outsider.id }, ownerCookie)).status, 404);
  assert.equal((await api('POST', '/api/team/owner', { userId: owner.id }, ownerCookie)).status, 400);

  const done = await api('POST', '/api/team/owner', { userId: heir.id }, ownerCookie);
  assert.equal(done.status, 200);
  // The caller's own view comes back demoted, with the owner-only invite list gone.
  assert.equal(done.json.team.role, 'member');
  assert.deepEqual(done.json.team.invites, []);

  assert.equal(teams.teamById.get(team.id).owner_user_id, heir.id);
  assert.equal(teams.roleFor(team.id, heir.id), 'owner');
  assert.equal(teams.roleFor(team.id, owner.id), 'member');
  // Headcount is untouched, so the seat bill doesn't move.
  assert.equal(teams.memberCount(team.id), 2);
  assert.equal(teams.billableSeats(team.id), 1);

  // The powers moved with the title.
  assert.equal((await api('POST', '/api/team/invites', { invitee: 'someone' }, ownerCookie)).status, 403);
  assert.equal((await api('POST', '/api/team/invites', { invitee: 'someone' }, heirCookie)).status, 200);
  assert.equal((await api('DELETE', '/api/team', null, ownerCookie)).status, 403);

  // And the former owner can now do the one thing they couldn't before.
  const tests = await api('GET', '/api/tests', null, ownerCookie);
  assert.equal(tests.status, 200);
  assert.equal((await api('DELETE', `/api/team/members/${owner.id}`, null, ownerCookie)).status, 200);
  assert.equal(teams.teamForUser(owner.id), null);
});

test('a demoted owner loses the team billing portal', async () => {
  const ownerCookie = await login('portalowner', 'free');
  const owner = userByLogin('portalowner');
  const team = paidTeam(owner.id, 'Portal');
  const heirCookie = await login('portalheir', 'free');
  teams.acceptInvite(teams.createInvite(team.id, 'portalheir', owner.id), userByLogin('portalheir'));
  const heir = userByLogin('portalheir');

  // Checkout points both the team and its buyer at the same Stripe customer.
  db.prepare("UPDATE teams SET stripe_customer_id = 'cus_test' WHERE id = ?").run(team.id);
  db.prepare("UPDATE users SET stripe_customer_id = 'cus_test' WHERE id = ?").run(owner.id);

  assert.equal((await api('POST', '/api/team/owner', { userId: heir.id }, ownerCookie)).status, 200);

  // Without the demotion check this would fall through to the personal customer
  // — which is the team's — and open the team's portal for a plain member.
  const portal = await api('POST', '/api/billing/portal', null, ownerCookie);
  assert.equal(portal.status, 403);
  assert.equal(portal.json.error, 'not_team_owner');
});

test('/api/me reports the team entitlement, not the member\'s free row', async () => {
  const ownerCookie = await login('meowner', 'free');
  const owner = userByLogin('meowner');
  const team = paidTeam(owner.id, 'Me Inc', 'year');
  const mateCookie = await login('memate', 'free');
  teams.acceptInvite(teams.createInvite(team.id, 'memate', owner.id), userByLogin('memate'));

  const { json } = await api('GET', '/api/me', null, mateCookie);
  assert.equal(json.plan, 'team');
  assert.equal(json.planLabel, 'Team');
  assert.equal(json.billingInterval, 'year');
  assert.equal(json.team.name, 'Me Inc');
  assert.equal(json.team.role, 'member');
  assert.equal(json.team.seats, 2);
  assert.equal(json.limits.activeTests, PLANS.individual.activeTests * 2);
});

test('retention sweeps team tests on the team plan, not the member\'s free plan', async () => {
  const ownerCookie = await login('retowner', 'free');
  const owner = userByLogin('retowner');
  const team = paidTeam(owner.id, 'Retention');
  const mateCookie = await login('retmate', 'free');
  teams.acceptInvite(teams.createInvite(team.id, 'retmate', owner.id), userByLogin('retmate'));

  const teamTest = await createTest('team-test', mateCookie);
  const solo = await login('retsolo', 'free');
  const soloTest = await createTest('solo-test', solo);

  // A session on each, aged past the free window (14 days) but inside the
  // paid one (365 days).
  const aged = Date.now() - 30 * DAY_MS;
  for (const t of [teamTest, soloTest]) {
    db.prepare("INSERT INTO sessions (id, test_id, status, started_at) VALUES (?, ?, 'completed', ?)")
      .run('sess-' + t.id, t.id, aged);
  }

  sweep();

  assert.ok(
    db.prepare('SELECT 1 FROM sessions WHERE id = ?').get('sess-' + teamTest.id),
    'team session survives — the team is on a 365-day window'
  );
  assert.ok(
    !db.prepare('SELECT 1 FROM sessions WHERE id = ?').get('sess-' + soloTest.id),
    'free solo session is swept at 14 days'
  );
});

test('a lapsed team keeps paid retention through the grace window, then drops', async () => {
  const ownerCookie = await login('graceowner', 'free');
  const owner = userByLogin('graceowner');
  const team = paidTeam(owner.id, 'Grace');
  const mateCookie = await login('gracemate', 'free');
  teams.acceptInvite(teams.createInvite(team.id, 'gracemate', owner.id), userByLogin('gracemate'));

  const t = await createTest('grace-test', mateCookie);
  // Aged past the free window (14 days) but inside the paid one (365).
  const aged = Date.now() - 30 * DAY_MS;
  db.prepare("INSERT INTO sessions (id, test_id, status, started_at) VALUES (?, ?, 'completed', ?)")
    .run('sess-grace', t.id, aged);
  db.prepare("UPDATE tests SET status = 'live', launched_at = ? WHERE id = ?").run(aged, t.id);

  // The subscription ends today.
  setTeamPlan(teams.teamById.get(team.id), 'free', null);
  const lapsedAt = teams.teamById.get(team.id).plan_lapsed_at;
  assert.ok(lapsedAt, 'the lapse is stamped');

  // Volume limits tighten immediately — that part is the plan working.
  assert.equal(planFor(userByLogin('gracemate')).label, 'Free');

  // But the data survives, and the live link stays open, for the whole window.
  sweep();
  assert.ok(db.prepare('SELECT 1 FROM sessions WHERE id = ?').get('sess-grace'), 'kept during grace');
  assert.equal(db.prepare('SELECT status FROM tests WHERE id = ?').get(t.id).status, 'live');

  // Everyone on the roster is told, with a date.
  for (const cookie of [ownerCookie, mateCookie]) {
    const { json } = await api('GET', '/api/team', null, cookie);
    assert.equal(json.team.graceEndsAt, lapsedAt + RETENTION_GRACE_DAYS * DAY_MS);
  }

  // One day past the window, the free rules apply.
  sweep(Date.now() + (RETENTION_GRACE_DAYS + 1) * DAY_MS);
  assert.ok(!db.prepare('SELECT 1 FROM sessions WHERE id = ?').get('sess-grace'), 'swept after grace');
  assert.equal(db.prepare('SELECT status FROM tests WHERE id = ?').get(t.id).status, 'closed');
});

test('the grace clock is stamped once and cleared on recovery', async () => {
  const cookie = await login('clockowner', 'free');
  const owner = userByLogin('clockowner');
  const team = paidTeam(owner.id, 'Clock');

  setTeamPlan(teams.teamById.get(team.id), 'free', null);
  const first = teams.teamById.get(team.id).plan_lapsed_at;
  assert.ok(first);

  // A replayed or repeated webhook must not push the deadline back.
  setTeamPlan(teams.teamById.get(team.id), 'free', null);
  assert.equal(teams.teamById.get(team.id).plan_lapsed_at, first, 'clock is not extended');

  // Fixing the card clears it outright.
  setTeamPlan(teams.teamById.get(team.id), 'team', 'sub_test');
  assert.equal(teams.teamById.get(team.id).plan_lapsed_at, null);
  const { json } = await api('GET', '/api/team', null, cookie);
  assert.equal(json.team.graceEndsAt, null);

  // And a team that never paid at all gets no grace — there's nothing to grace.
  const neverCookie = await login('neverpaid', 'free');
  const neverTeam = teams.createTeam(userByLogin('neverpaid').id, 'Never', 'month');
  assert.equal(teams.teamById.get(neverTeam.id).plan_lapsed_at, null);
  assert.equal((await api('GET', '/api/team', null, neverCookie)).json.team.graceEndsAt, null);
});

test('billing endpoints degrade cleanly when Stripe is unconfigured', async () => {
  const cookie = await login('nostripe', 'free');
  const checkout = await api('POST', '/api/billing/checkout', { plan: 'team', interval: 'year' }, cookie);
  assert.equal(checkout.status, 503);
  assert.equal(checkout.json.error, 'billing_not_configured');
  // Critically: a failed checkout must not have left a team behind.
  assert.equal(teams.teamForUser(userByLogin('nostripe').id), null);

  const me = await api('GET', '/api/me', null, cookie);
  assert.equal(me.json.billingConfigured, false);
});

test('an unpaid team (abandoned checkout) grants nothing and cannot invite', async () => {
  const cookie = await login('abandoned', 'free');
  const owner = userByLogin('abandoned');
  // What checkout leaves behind when the buyer never reaches Stripe.
  teams.createTeam(owner.id, 'Never paid', 'month');

  assert.equal(planFor(userByLogin('abandoned')).label, 'Free');
  const invite = await api('POST', '/api/team/invites', { invitee: 'someone' }, cookie);
  assert.equal(invite.status, 402);
  assert.equal(invite.json.error, 'team_not_subscribed');
});
