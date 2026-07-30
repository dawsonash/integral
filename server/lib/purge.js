// Hard-deletes: a test with everything it recorded, or a whole account.
// Used by the delete endpoints and the retention sweep — data on disk
// (artifact dirs, rrweb event files) must go with the rows.
const fs = require('fs');
const path = require('path');
const { db, EVENTS_DIR } = require('../db');
const { artifactRoot } = require('./artifacts');

function deleteSessionRows(sessionIds) {
  for (const sid of sessionIds) {
    const file = path.join(EVENTS_DIR, sid + '.jsonl');
    fs.rmSync(file, { force: true });
  }
  const del = db.transaction((ids) => {
    const delInteractions = db.prepare('DELETE FROM interactions WHERE session_id = ?');
    const delSession = db.prepare('DELETE FROM sessions WHERE id = ?');
    for (const sid of ids) {
      delInteractions.run(sid);
      delSession.run(sid);
    }
  });
  del(sessionIds);
}

async function deleteTestData(testId) {
  const sessionIds = db.prepare('SELECT id FROM sessions WHERE test_id = ?').all(testId).map((r) => r.id);
  deleteSessionRows(sessionIds);
  db.prepare('DELETE FROM reports WHERE test_id = ?').run(testId);
  db.prepare('DELETE FROM tests WHERE id = ?').run(testId);
  // Stop any live sandbox (child process + throwaway DB) *before* removing the
  // artifact dir, not after: that directory is the running app's cwd and HOME,
  // and under confinement its files belong to the sandbox uid. Deleting it out
  // from under a live child raced against files still being written, and now
  // risks a partly-removed tree this process can no longer finish cleaning.
  await require('./sandbox/registry').teardown(testId).catch(() => {});
  fs.rmSync(artifactRoot(testId), { recursive: true, force: true });
}

async function deleteUserData(userId) {
  const testIds = db.prepare('SELECT id FROM tests WHERE user_id = ?').all(userId).map((r) => r.id);
  for (const id of testIds) await deleteTestData(id);
  // Team rows the account leaves behind. Callers (routes/auth.js) already
  // settled the roster — dropping the team or releasing the seat — so this is
  // just making sure nothing dangles.
  db.prepare('DELETE FROM team_members WHERE user_id = ?').run(userId);
  db.prepare('UPDATE team_invites SET invited_by = NULL WHERE invited_by = ?').run(userId);
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
}

module.exports = { deleteTestData, deleteUserData, deleteSessionRows };
