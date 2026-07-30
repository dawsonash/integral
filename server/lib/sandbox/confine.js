// Where the sandboxed app's process actually runs (docs/fake-backend-spec.md §9).
//
// runner.js spawns a connected repo's own commands. Without confinement they
// run as the Integral service user — the uid that owns /opt/integral/.env
// (live Stripe key, OAuth secret, session secret) and can write
// data/integral.db. buildEnv() withholds Integral's process.env from the child,
// but that only hides the values; the files are still right there on disk.
//
// This module puts the child behind deploy/integral-sandbox-run: a root-owned
// wrapper that drops to the unprivileged `integral-sbx` uid inside a systemd
// scope with memory/CPU/task/wall-clock caps and cgroup-level address
// filtering. The wrapper holds every security parameter, so a compromised
// Integral process cannot ask for a weaker sandbox — it only supplies a unit
// name, a profile, a working directory and a command.
//
// Tier 1: a separate uid on a shared kernel. It is not a container, and the
// INTEGRAL_SANDBOX_ALLOW entitlement in policy.js is still what keeps
// untrusted repos out.
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { DATA_DIR } = require('../../db');
const { sbxIdent } = require('./db');

const SUDO = '/usr/bin/sudo';
// Overridable so the test suite can point at a stub. Not a way to weaken the
// sandbox in production: the sudoers rule grants NOPASSWD for one absolute
// path, so any other value simply fails the sudo call.
const WRAPPER = () => process.env.INTEGRAL_SANDBOX_WRAPPER || '/usr/local/bin/integral-sandbox-run';

// Files that must be out of the sandbox user's reach for the uid split to mean
// anything. INTEGRAL_ENV_FILE covers installs that keep .env elsewhere.
function secretPaths() {
  return [
    process.env.INTEGRAL_ENV_FILE || path.join(process.cwd(), '.env'),
    path.join(DATA_DIR, 'integral.db'),
  ];
}

// 'auto' (default) mirrors the line policy.js draws: strict in production,
// permissive outside it so local dev and the test suite run untouched.
function configuredMode() {
  const v = String(process.env.INTEGRAL_SANDBOX_CONFINE || 'auto').trim().toLowerCase();
  return ['off', 'auto', 'require'].includes(v) ? v : 'auto';
}

function strict() {
  return configuredMode() === 'require' || process.env.NODE_ENV === 'production';
}

function notConfined(reason) {
  const err = new Error(
    'Server-rendered tests are unavailable on this instance: the sandbox cannot be ' +
      `confined, and running the app unconfined would give it the Integral service ` +
      `user's access to secrets. (${reason}) See deploy/README.md.`
  );
  err.code = 'SANDBOX_NOT_CONFINED';
  return err;
}

// ---- wrapper probe -------------------------------------------------------

let probeCache = null; // { key, result }

// Is the wrapper present, root-owned, untamperable, and reachable through
// sudo without a password? Returns { ok, uid, gid, groups } or { ok:false, reason }.
function probeWrapper() {
  const wrapper = WRAPPER();
  if (probeCache && probeCache.key === wrapper) return probeCache.result;
  const result = runProbe(wrapper);
  probeCache = { key: wrapper, result };
  return result;
}

function runProbe(wrapper) {
  let st;
  try {
    st = fs.statSync(wrapper);
  } catch (e) {
    return { ok: false, reason: `${wrapper} is not installed` };
  }
  if (!st.isFile()) return { ok: false, reason: `${wrapper} is not a regular file` };
  // Root-owned and not writable by group or other: otherwise whoever can edit
  // it can rewrite the policy the wrapper exists to hold.
  if (st.uid !== 0) return { ok: false, reason: `${wrapper} is not owned by root` };
  if (st.mode & 0o022) return { ok: false, reason: `${wrapper} is group- or world-writable` };

  const r = spawnSync(SUDO, ['-n', wrapper, '--check'], { encoding: 'utf8', timeout: 10000 });
  if (r.error) return { ok: false, reason: `cannot run ${wrapper}: ${r.error.message}` };
  if (r.status !== 0) {
    const why = String(r.stderr || r.stdout || '').trim().split('\n')[0] || `exit ${r.status}`;
    return { ok: false, reason: `${wrapper} --check failed: ${why}` };
  }
  // "ok <uid> <gid> <gid,gid,...>"
  const m = /^ok\s+(\d+)\s+(\d+)\s+([\d,]*)/.exec(String(r.stdout || '').trim());
  if (!m) return { ok: false, reason: `${wrapper} --check returned unexpected output` };
  return {
    ok: true,
    uid: Number(m[1]),
    gid: Number(m[2]),
    groups: m[3].split(',').filter(Boolean).map(Number),
  };
}

// ---- secret reachability -------------------------------------------------

// Can the sandbox user read this file? Checks the three ways in: it owns the
// file, it is in the file's group and the group bit is set, or the file is
// world-readable (the default 0644 an unadjusted install leaves behind).
function readableBy(file, who) {
  let st;
  try {
    st = fs.statSync(file);
  } catch (e) {
    return null; // absent — nothing to leak
  }
  if (st.mode & 0o004) return `${file} is world-readable`;
  if (st.uid === who.uid) return `${file} is owned by the sandbox user`;
  if (st.mode & 0o040 && (who.gid === st.gid || who.groups.includes(st.gid))) {
    return `${file} is readable by the sandbox user's group`;
  }
  return null;
}

function secretLeaks(who) {
  return secretPaths().map((f) => readableBy(f, who)).filter(Boolean);
}

// ---- public API ----------------------------------------------------------

let warned = false;
function warnOnce(reason) {
  if (warned) return;
  warned = true;
  console.warn(
    `[sandbox] running UNCONFINED — the app gets this process's filesystem access (${reason}). ` +
      'Fine for local development; set INTEGRAL_SANDBOX_CONFINE=require to make this an error.'
  );
}

// Resolve how the next sandbox will be run. Throws SANDBOX_NOT_CONFINED rather
// than silently downgrading whenever confinement is required but unavailable.
// Call before provisioning anything, so a misconfigured host fails before it
// creates a database.
function preflight() {
  if (configuredMode() === 'off') return { mode: 'none' };

  const probe = probeWrapper();
  if (!probe.ok) {
    if (strict()) throw notConfined(probe.reason);
    warnOnce(probe.reason);
    return { mode: 'none' };
  }

  // The wrapper works, but the uid split is only real if the filesystem backs
  // it up. A half-finished deploy/README.md §setup leaves .env at 0644 and the
  // separate uid buys nothing.
  const leaks = secretLeaks(probe);
  if (leaks.length) {
    if (strict()) throw notConfined(leaks.join('; '));
    warnOnce(`confined, but ${leaks.join('; ')}`);
  }
  return { mode: 'systemd' };
}

function unitFor(testId) {
  return `integral-sbx-${sbxIdent(testId)}`;
}

// Drop-in for spawn(cmd, { shell: true, ... }). `profile` is 'app' (schema,
// seed, start — loopback only) or 'install' (npm/pip — real network, minus
// link-local and RFC1918).
function spawnConfined(cmd, { cwd, env, unit, profile, detached = false, confined }) {
  if (!confined) return spawn(cmd, { shell: true, cwd, env, detached });
  // -E carries buildEnv()'s output through sudo (needs the SETENV tag in
  // sudoers). Passing the env rather than --setenv= keeps the throwaway DB
  // password out of argv, where /proc would expose it to every local user.
  return spawn(SUDO, ['-n', '-E', WRAPPER(), unit, profile, cwd, cmd], { cwd, env, detached });
}

// Stopping the scope kills its whole cgroup, so nothing survives by detaching
// (the `setsid` escape from a plain process-group kill).
function killConfined(unit) {
  const r = spawnSync(SUDO, ['-n', WRAPPER(), '--stop', unit], { timeout: 10000, encoding: 'utf8' });
  return !r.error && r.status === 0;
}

// Tests flip INTEGRAL_SANDBOX_WRAPPER / NODE_ENV between cases.
function resetCache() {
  probeCache = null;
  warned = false;
}

module.exports = {
  preflight, spawnConfined, killConfined, unitFor,
  configuredMode, probeWrapper, readableBy, resetCache,
};
