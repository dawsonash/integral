// Ephemeral DB provisioning: one local Postgres instance, one throwaway
// database per test (spec §11 decision 2). The admin connection creates and
// drops `integral_sbx_<testid>`; the sandboxed app gets plain connection
// coordinates to that database and nothing else. Prototype posture (spec §9):
// the DB user is the admin user — isolation comes later with containers.
const { Client } = require('pg');

const ADMIN_URL =
  process.env.INTEGRAL_SANDBOX_PG_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

function dbNameFor(testId) {
  return 'integral_sbx_' + String(testId).toLowerCase().replace(/[^a-z0-9_]/g, '');
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

// Fresh throwaway database; any leftover from a previous run is dropped
// first so every boot starts from a clean slate.
async function provision(testId) {
  const name = dbNameFor(testId);
  const admin = await adminClient();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
  const u = new URL(ADMIN_URL);
  return {
    host: u.hostname || '127.0.0.1',
    port: u.port || '5432',
    user: decodeURIComponent(u.username || 'postgres'),
    password: decodeURIComponent(u.password || ''),
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
    await admin.query(`DROP DATABASE IF EXISTS "${dbNameFor(testId)}" WITH (FORCE)`);
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

module.exports = { provision, drop, withDb, dbNameFor, ADMIN_URL };
