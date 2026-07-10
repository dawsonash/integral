// testId → running sandbox. Dedupe concurrent boots (every asset request of
// the first page load arrives while the app is still booting), cap how many
// apps run at once, and tear down idle ones so a forgotten preview doesn't
// pin a child process + database forever.
const runner = require('./runner');
const { backendConfigFor } = require('./classify');

const MAX = () => Number(process.env.INTEGRAL_SANDBOX_MAX || 2);
const IDLE_MS = () => Number(process.env.INTEGRAL_SANDBOX_IDLE_MS || 15 * 60 * 1000);
// A failed boot is remembered briefly so a page full of asset requests
// doesn't re-provision a database per request while the config is broken.
const ERROR_COOLDOWN_MS = 10000;

const entries = new Map(); // testId → { promise, handle, error, erroredAt, lastUsed }
let sweepTimer = null;

function ensureSweeper() {
  if (sweepTimer) return;
  sweepTimer = setInterval(sweepIdle, 60000);
  sweepTimer.unref();
}

async function ensure(test) {
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
  // is hot (a 502 the proxy turns into a friendly try-again page).
  while (entries.size >= MAX()) {
    const idlest = [...entries.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
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
    if (now - entry.lastUsed > IDLE_MS()) teardown(testId);
  }
}

// §7 v1 ships shared state; per-session isolation (transaction rollback /
// reseed / template-DB fork) hangs off this hook in v1.5/v2.
function resetForSession(testId, sessionId) {} // eslint-disable-line no-unused-vars

function runningCount() {
  return entries.size;
}

module.exports = { ensure, teardown, teardownAll, sweepIdle, resetForSession, runningCount };
