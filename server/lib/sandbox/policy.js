// Who may run the fake-backend sandbox (docs/fake-backend-spec.md §9).
//
// Booting a sandbox runs the repo's own code — its start command, its schema
// and seed commands, its dependencies' install scripts — as a child process on
// this host. That is remote code execution as a documented feature, and the
// spec is explicit that the prototype is for trusted repos only. So it is not
// a capability every signed-up stranger gets: a production instance runs it
// for an explicit allowlist and for nobody else.
//
// INTEGRAL_SANDBOX_ALLOW is a comma-separated list of GitHub logins, or '*'
// for everyone — '*' is for single-tenant installs only, since it hands a
// shell to every user of the deployment. Outside production the sandbox stays
// on by default so local development and the test suite work untouched; that
// mirrors devLoginEnabled() in lib/auth.js, which draws the same line.
const { db } = require('../../db');

function allowList() {
  return String(process.env.INTEGRAL_SANDBOX_ALLOW || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function sandboxEnabledFor(user) {
  const allow = allowList();
  if (allow.includes('*')) return true;
  if (user && user.login && allow.includes(String(user.login).toLowerCase())) return true;
  return process.env.NODE_ENV !== 'production';
}

// Boot-time gate. The requester at that point is an anonymous testee, so the
// entitlement that matters is the owner's: whoever's repo this is must be
// allowed to run code here. Checked at boot rather than only at creation
// because a server test row outlives the entitlement that created it — an
// allowlist gets edited, an instance moves to production.
function sandboxEnabledForTest(test) {
  if (!test || !test.user_id) return sandboxEnabledFor(null);
  const owner = db.prepare('SELECT login FROM users WHERE id = ?').get(test.user_id);
  return sandboxEnabledFor(owner);
}

const DISABLED_MESSAGE =
  'Server-rendered tests are in limited preview on this instance. ' +
  'Static, SPA, and React artifacts work normally.';

function disabledError() {
  const err = new Error(DISABLED_MESSAGE);
  err.code = 'SANDBOX_DISABLED';
  return err;
}

module.exports = { allowList, sandboxEnabledFor, sandboxEnabledForTest, disabledError, DISABLED_MESSAGE };
