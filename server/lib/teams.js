// Teams: a shared workspace. Membership is what the Team plan actually sells —
// every member sees and manages the same tests, results, and replays, and the
// team's pooled limits scale with how many people are in it.
//
// A user belongs to at most one team. Joining moves their existing tests into
// the team; leaving hands those tests to the team owner (see releaseMember),
// so a departing teammate never takes the team's research with them.
const crypto = require('crypto');
const { db } = require('../db');

// The base Team price covers the workspace plus the owner's seat; every
// teammate beyond the owner is a billable seat at the per-seat price.
const TEAM_INCLUDED_SEATS = 1;

const teamById = db.prepare('SELECT * FROM teams WHERE id = ?');
const membershipFor = db.prepare('SELECT * FROM team_members WHERE user_id = ?');

// The single source of truth for "which team is this user in" — used by plan
// resolution and by every ownership scope check, so it stays a cheap lookup.
function teamForUser(userId) {
  const m = membershipFor.get(userId);
  return m ? teamById.get(m.team_id) : null;
}

function roleFor(teamId, userId) {
  const m = db.prepare('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?').get(teamId, userId);
  return m ? m.role : null;
}

function memberCount(teamId) {
  return db.prepare('SELECT COUNT(*) AS n FROM team_members WHERE team_id = ?').get(teamId).n;
}

// What Stripe charges the per-seat price for. Never negative: a solo team owner
// is covered entirely by the base price.
function billableSeats(teamId) {
  return Math.max(0, memberCount(teamId) - TEAM_INCLUDED_SEATS);
}

function members(teamId) {
  return db
    .prepare(
      `SELECT u.id, u.login, u.name, u.email, u.avatar_url, tm.role, tm.created_at AS joined_at
       FROM team_members tm JOIN users u ON u.id = tm.user_id
       WHERE tm.team_id = ? ORDER BY tm.created_at ASC`
    )
    .all(teamId);
}

function pendingInvites(teamId) {
  return db
    .prepare(
      'SELECT id, invitee, token, created_at FROM team_invites WHERE team_id = ? AND accepted_at IS NULL ORDER BY created_at ASC'
    )
    .all(teamId);
}

// ---------- mutations ----------

// Creating a team sweeps the founder's existing tests into it, so upgrading
// doesn't strand the work they already have.
const createTeam = db.transaction((ownerId, name, interval) => {
  const now = Date.now();
  const info = db
    .prepare('INSERT INTO teams (name, owner_user_id, plan, billing_interval, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(name, ownerId, 'free', interval === 'year' ? 'year' : 'month', now);
  const teamId = Number(info.lastInsertRowid);
  db.prepare('INSERT INTO team_members (team_id, user_id, role, created_at) VALUES (?, ?, ?, ?)')
    .run(teamId, ownerId, 'owner', now);
  db.prepare('UPDATE tests SET team_id = ? WHERE user_id = ? AND team_id IS NULL').run(teamId, ownerId);
  return teamById.get(teamId);
});

function createInvite(teamId, invitee, invitedBy) {
  const token = crypto.randomBytes(24).toString('hex');
  const info = db
    .prepare('INSERT INTO team_invites (team_id, invitee, token, invited_by, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(teamId, String(invitee).trim().toLowerCase(), token, invitedBy, Date.now());
  return db.prepare('SELECT * FROM team_invites WHERE id = ?').get(info.lastInsertRowid);
}

// An invite names a person by GitHub login or email; either identity may be how
// they eventually sign in, so accepting matches on both.
function inviteMatchesUser(invite, user) {
  const want = invite.invitee;
  return want === String(user.login || '').toLowerCase() || want === String(user.email || '').toLowerCase();
}

const acceptInvite = db.transaction((invite, user) => {
  const now = Date.now();
  db.prepare('INSERT INTO team_members (team_id, user_id, role, created_at) VALUES (?, ?, ?, ?)')
    .run(invite.team_id, user.id, 'member', now);
  db.prepare('UPDATE team_invites SET accepted_at = ? WHERE id = ?').run(now, invite.id);
  // Whatever they built solo comes with them into the shared workspace.
  db.prepare('UPDATE tests SET team_id = ? WHERE user_id = ? AND team_id IS NULL').run(invite.team_id, user.id);
  return teamById.get(invite.team_id);
});

// Removing a member (or their own "leave") transfers the tests they made inside
// the team to the owner: the team paid for that research, and orphaned rows
// would fall out of every team-scoped query.
const releaseMember = db.transaction((teamId, userId) => {
  const team = teamById.get(teamId);
  db.prepare('UPDATE tests SET user_id = ? WHERE team_id = ? AND user_id = ?')
    .run(team.owner_user_id, teamId, userId);
  db.prepare('DELETE FROM team_members WHERE team_id = ? AND user_id = ?').run(teamId, userId);
});

// Disbanding: tests fall back to personal ownership under the owner's account.
const deleteTeam = db.transaction((teamId) => {
  const team = teamById.get(teamId);
  db.prepare('UPDATE tests SET user_id = ?, team_id = NULL WHERE team_id = ?').run(team.owner_user_id, teamId);
  db.prepare('DELETE FROM team_members WHERE team_id = ?').run(teamId);
  db.prepare('DELETE FROM team_invites WHERE team_id = ?').run(teamId);
  db.prepare('DELETE FROM teams WHERE id = ?').run(teamId);
});

module.exports = {
  TEAM_INCLUDED_SEATS,
  teamForUser, teamById, roleFor, memberCount, billableSeats, members, pendingInvites,
  createTeam, createInvite, inviteMatchesUser, acceptInvite, releaseMember, deleteTeam,
};
