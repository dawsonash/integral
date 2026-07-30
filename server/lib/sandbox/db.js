// Ephemeral DB provisioning: one local Postgres instance, one throwaway
// database per test (spec §11 decision 2), owned by a throwaway unprivileged
// role. The admin connection creates and drops both; the sandboxed app only
// ever sees the role's coordinates.
//
// The app must never get superuser. A superuser connection is a host
// compromise on its own — COPY ... FROM PROGRAM executes shell commands as
// the postgres OS user, pg_read_file reads the host filesystem, and ACLs stop
// applying, so every other database on the instance is readable. Owning one
// database is all a sandboxed app needs, and it is all it gets.
const crypto = require('crypto');
const { Client } = require('pg');

const ADMIN_URL =
  process.env.INTEGRAL_SANDBOX_PG_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

// Identifiers are built from the test id reduced to [a-z0-9_], so the double
// quoting below can't be broken out of.
function sbxIdent(testId) {
  return String(testId).toLowerCase().replace(/[^a-z0-9_]/g, '');
}

function dbNameFor(testId) {
  return 'integral_sbx_' + sbxIdent(testId);
}

function roleNameFor(testId) {
  return 'integral_sbx_' + sbxIdent(testId) + '_role';
}

async function adminClient() {
  const client = new Client({ connectionString: ADMIN_URL, connectionTimeoutMillis: 4000 });
  try {
    await client.connect();
  } catch (e) {
    const err = new Error(
      `Sandbox Postgres is unreachable at ${ADMIN_URL.replace(/\/\/[^@]*@/, '//…@')} — ` +
        'start a local Postgres or set INTEGRAL_SANDBOX_PG_URL. ' +
        `(${e.message})`
    );
    err.code = 'SANDBOX_PG_UNREACHABLE';
    throw err;
  }
  return client;
}

// Fresh throwaway database and its owning role; any leftover from a previous
// run is dropped first so every boot starts from a clean slate.
async function provision(testId) {
  const name = dbNameFor(testId);
  const role = roleNameFor(testId);
  // Hex, so it cannot carry a quote into the CREATE ROLE literal below (DDL
  // takes no bind parameters) or need escaping in the connection URL.
  const password = crypto.randomBytes(24).toString('hex');
  const admin = await adminClient();
  try {
    // The database must go before the role that owns it.
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.query(`DROP ROLE IF EXISTS "${role}"`);
    await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`);
    await admin.query(`CREATE DATABASE "${name}" OWNER "${role}"`);
    // A fresh database leaves CONNECT granted to PUBLIC, which would let one
    // test's app open another test's database. Each sandbox is a different
    // tenant's code; only its own role gets in.
    await admin.query(`REVOKE CONNECT ON DATABASE "${name}" FROM PUBLIC`);
    await admin.query(`GRANT CONNECT ON DATABASE "${name}" TO "${role}"`);
  } catch (e) {
    // Most likely the admin role lacks CREATEROLE (a managed Postgres with a
    // restricted owner). Fail loudly rather than falling back to handing the
    // app admin credentials — that fallback is the privilege being removed.
    const err = new Error(
      `Sandbox database provisioning failed: ${e.message}. The role at ` +
        'INTEGRAL_SANDBOX_PG_URL needs CREATEDB and CREATEROLE.'
    );
    err.code = 'SANDBOX_PG_PROVISION_FAILED';
    throw err;
  } finally {
    await admin.end();
  }
  const u = new URL(ADMIN_URL);
  return {
    host: u.hostname || '127.0.0.1',
    port: u.port || '5432',
    user: role,
    password,
    database: name,
    get url() {
      const auth = this.password ? `${this.user}:${this.password}` : this.user;
      return `postgres://${auth}@${this.host}:${this.port}/${this.database}`;
    },
  };
}

async function drop(testId) {
  const admin = await adminClient();
  try {
    // Database first: a role owning objects cannot be dropped.
    await admin.query(`DROP DATABASE IF EXISTS "${dbNameFor(testId)}" WITH (FORCE)`);
    await admin.query(`DROP ROLE IF EXISTS "${roleNameFor(testId)}"`);
  } finally {
    await admin.end();
  }
}

// Run fn(query) against the ephemeral DB with a short-lived connection.
async function withDb(coords, fn) {
  const client = new Client({
    host: coords.host, port: Number(coords.port), user: coords.user,
    password: coords.password, database: coords.database,
    connectionTimeoutMillis: 4000,
  });
  await client.connect();
  try {
    return await fn((text, params) => client.query(text, params));
  } finally {
    await client.end();
  }
}

module.exports = { provision, drop, withDb, sbxIdent, dbNameFor, roleNameFor, ADMIN_URL };
