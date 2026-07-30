// testId → running sandbox. Dedupe concurrent boots (every asset request of
// the first page load arrives while the app is still booting), cap how many
// apps run at once, and tear down idle ones so a forgotten preview doesn't
// pin a child process + database forever.
const runner = require('./runner');
const { backendConfigFor } = require('./classify');
const { sandboxEnabledForTest, disabledError } = require('./policy');

const MAX = () => Number(process.env.INTEGRAL_SANDBOX_MAX || 2);
const IDLE_MS = () => Number(process.env.INTEGRAL_SANDBOX_IDLE_MS || 15 * 60 * 1000);
// A failed boot is remembered briefly so a page full of asset requests
// doesn't re-provision a database per request while the config is broken.
const ERROR_COOLDOWN_MS = 10000;

const entries = new Map(); // testId → { promise, handle, error, erroredAt, lastUsed }
let sweepTimer = null;

// Entries that still hold something: a booting or running app. An errored entry
// is only a cooldown marker for repeat requests to the same test.
function live() {
  return [...entries.entries()].filter(([, e]) => !e.error);
}

function ensureSweeper() {
  if (sweepTimer) return;
  sweepTimer = setInterval(sweepIdle, 60000);
  sweepTimer.unref();
}

async function ensure(test) {
  // The authoritative gate (lib/sandbox/policy.js): nothing is spawned, no
  // database is provisioned, and no config is read until the owner is known
  // to be allowed to run code on this host.
  if (!sandboxEnabledForTest(test)) throw disabledError();

  const existing = entries.get(test.id);
  if (existing) {
    existing.lastUsed = Date.now();
    const appDied = existing.handle && existing.handle.exited !== null;
    if (!existing.error && !appDied) return existing.promise; // booting or healthy
    if (existing.error && Date.now() - existing.erroredAt < ERROR_COOLDOWN_MS) throw existing.error;
    entries.delete(test.id);
    if (existing.handle) await runner.teardown(existing.handle).catch(() => {});
  }

  // At capacity: evict the longest-idle sandbox, or refuse when everything
  // is hot (a 502 the proxy turns into a friendly try-again page). Only live
  // entries count — a failed boot already tore down its process and database in
  // runner.boot's catch, so it holds nothing and must not occupy a slot. It
  // used to, which meant two broken configs wedged the feature for everyone and
  // replaced the real error with a misleading "capacity reached".
  while (live().length >= MAX()) {
    const idlest = live().sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
    if (idlest && Date.now() - idlest[1].lastUsed > 30000) {
      await teardown(idlest[0]);
    } else {
      const err = new Error('Sandbox capacity reached — another test is running. Try again in a moment.');
      err.code = 'SANDBOX_CAPACITY';
      throw err;
    }
  }

  const config = backendConfigFor(test);
  if (!config || config.kind !== 'server') throw new Error('Test has no server backend_config.');
  const entry = { handle: null, error: null, erroredAt: 0, lastUsed: Date.now() };
  entry.promise = runner.boot(test, config).then(
    (h) => { entry.handle = h; return h; },
    (e) => { entry.error = e; entry.erroredAt = Date.now(); throw e; }
  );
  entries.set(test.id, entry);
  ensureSweeper();
  return entry.promise;
}

async function teardown(testId) {
  const entry = entries.get(testId);
  if (!entry) return;
  entries.delete(testId);
  const handle = entry.handle || (await entry.promise.catch(() => null));
  if (handle) await runner.teardown(handle).catch(() => {});
}

async function teardownAll() {
  await Promise.all([...entries.keys()].map((id) => teardown(id)));
}

function sweepIdle(now = Date.now()) {
  for (const [testId, entry] of entries) {
    // Expired cooldown markers are just map litter — drop them so the next
    // request retries the boot instead of replaying a stale error.
    if (entry.error && now - entry.erroredAt > ERROR_COOLDOWN_MS) {
      entries.delete(testId);
      continue;
    }
    if (now - entry.lastUsed > IDLE_MS()) teardown(testId);
  }
}

// §7 v1 ships shared state; per-session isolation (transaction rollback /
// reseed / template-DB fork) hangs off this hook in v1.5/v2.
function resetForSession(testId, sessionId) {} // eslint-disable-line no-unused-vars

function runningCount() {
  return live().length;
}

module.exports = { ensure, teardown, teardownAll, sweepIdle, resetForSession, runningCount };
