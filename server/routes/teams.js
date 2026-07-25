// Team roster management. The Team plan's per-seat charge is driven entirely by
// what happens here, so every mutation that changes headcount ends with a
// syncSeats() so Stripe's quantity matches the roster.
const express = require('express');
const { db } = require('../db');
const { requireUser } = require('../lib/auth');
const { planFor } = require('../lib/plans');
const teams = require('../lib/teams');
const { syncSeats } = require('./billing');

const router = express.Router();

router.use('/api/team', requireUser);

function appUrl(req) {
  return process.env.INTEGRAL_APP_URL || `${req.protocol}://${req.get('host')}`;
}

// Loads the caller's team and role, 404s when they aren't in one.
function withTeam(req, res, next) {
  const team = teams.teamForUser(req.user.id);
  if (!team) return res.status(404).json({ error: 'no_team', message: 'You are not part of a team.' });
  req.team = team;
  req.role = teams.roleFor(team.id, req.user.id);
  next();
}

function requireOwner(req, res, next) {
  if (req.role !== 'owner') {
    return res.status(403).json({ error: 'not_team_owner', message: 'Only the team owner can do that.' });
  }
  next();
}

function teamJson(req) {
  const team = req.team;
  const plan = planFor(req.user);
  return {
    id: team.id,
    name: team.name,
    plan: team.plan,
    billingInterval: team.billing_interval,
    role: req.role,
    seats: teams.memberCount(team.id),
    billableSeats: teams.billableSeats(team.id),
    members: teams.members(team.id),
    invites: req.role === 'owner'
      ? teams.pendingInvites(team.id).map((i) => ({ ...i, url: appUrl(req) + '/join/' + i.token }))
      : [],
    limits: { activeTests: plan.activeTests, responsesPerMonth: plan.responsesPerMonth },
  };
}

router.get('/api/team', (req, res) => {
  const team = teams.teamForUser(req.user.id);
  if (!team) return res.json({ team: null });
  req.team = team;
  req.role = teams.roleFor(team.id, req.user.id);
  res.json({ team: teamJson(req) });
});

router.patch('/api/team', withTeam, requireOwner, (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: 'invalid_name', message: 'Team name cannot be empty.' });
  db.prepare('UPDATE teams SET name = ? WHERE id = ?').run(name, req.team.id);
  req.team = teams.teamById.get(req.team.id);
  res.json({ team: teamJson(req) });
});

// ---------- invites ----------

router.post('/api/team/invites', withTeam, requireOwner, async (req, res) => {
  // Checkout provisions the team before redirecting to Stripe, so an abandoned
  // payment leaves a team row sitting on the free plan. It grants no
  // entitlements, and it must not grow a roster either — seats added here
  // would never reach a subscription to be billed against.
  if (req.team.plan !== 'team') {
    return res.status(402).json({
      error: 'team_not_subscribed',
      message: 'Finish checkout for the Team plan before inviting teammates.',
    });
  }
  const invitee = String(req.body?.invitee || '').trim().toLowerCase();
  if (!invitee) {
    return res.status(400).json({ error: 'invalid_invitee', message: 'Provide a GitHub username or email address.' });
  }
  const already = teams.members(req.team.id)
    .some((m) => String(m.login).toLowerCase() === invitee || String(m.email || '').toLowerCase() === invitee);
  if (already) {
    return res.status(409).json({ error: 'already_member', message: 'That person is already on the team.' });
  }
  const open = teams.pendingInvites(req.team.id).find((i) => i.invitee === invitee);
  const invite = open || teams.createInvite(req.team.id, invitee, req.user.id);
  res.json({ invite: { ...invite, url: appUrl(req) + '/join/' + invite.token } });
});

router.delete('/api/team/invites/:id', withTeam, requireOwner, (req, res) => {
  db.prepare('DELETE FROM team_invites WHERE id = ? AND team_id = ? AND accepted_at IS NULL')
    .run(Number(req.params.id), req.team.id);
  res.json({ ok: true });
});

// Accepting is the one team endpoint a non-member calls, so it hangs off the
// invite token rather than the caller's (nonexistent) membership.
router.post('/api/team/join/:token', requireUser, async (req, res) => {
  const invite = db
    .prepare('SELECT * FROM team_invites WHERE token = ? AND accepted_at IS NULL')
    .get(String(req.params.token));
  if (!invite) return res.status(404).json({ error: 'invalid_invite', message: 'This invite is no longer valid.' });
  if (!teams.inviteMatchesUser(invite, req.user)) {
    return res.status(403).json({
      error: 'invite_mismatch',
      message: `This invite was sent to ${invite.invitee}. Sign in as that account to accept it.`,
    });
  }
  if (teams.teamForUser(req.user.id)) {
    return res.status(409).json({ error: 'already_in_team', message: 'Leave your current team before joining another.' });
  }
  const team = teams.acceptInvite(invite, req.user);
  // One more teammate = one more billable seat.
  await syncSeats(team);
  res.json({ ok: true, teamId: team.id });
});

// ---------- membership ----------

router.delete('/api/team/members/:userId', withTeam, async (req, res) => {
  const target = Number(req.params.userId);
  const isSelf = target === req.user.id;
  if (!isSelf && req.role !== 'owner') {
    return res.status(403).json({ error: 'not_team_owner', message: 'Only the team owner can remove members.' });
  }
  if (target === req.team.owner_user_id) {
    return res.status(400).json({
      error: 'owner_cannot_leave',
      message: 'The owner cannot leave. Delete the team instead, or transfer ownership first.',
    });
  }
  if (!teams.roleFor(req.team.id, target)) {
    return res.status(404).json({ error: 'not_found', message: 'That person is not on the team.' });
  }
  teams.releaseMember(req.team.id, target);
  await syncSeats(teams.teamById.get(req.team.id));
  res.json({ ok: true });
});

// Disbanding cancels the subscription; tests revert to the owner personally.
router.delete('/api/team', withTeam, requireOwner, async (req, res) => {
  const team = req.team;
  if (team.stripe_subscription_id && process.env.STRIPE_SECRET_KEY) {
    try {
      const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
      await stripe.subscriptions.cancel(team.stripe_subscription_id);
    } catch (e) {
      console.error('[billing] team subscription cancel failed:', e.message);
    }
  }
  teams.deleteTeam(team.id);
  res.json({ ok: true });
});

module.exports = router;
