// Auto-auth: gated pages must render without a real login (spec §2). The
// proxy attaches whatever this module establishes to every inbound request,
// so each tester arrives "already signed in" as the fake user.
//
//   mode: 'none'            nothing attached
//   mode: 'header'          static headers (config.auth.headers)
//   mode: 'session-cookie'  a session cookie, produced by one of:
//     strategy 'express-session'  forge a cookie signed with the dummy
//         SESSION_SECRET we booted the app with, and seed the matching row
//         into the ephemeral DB's session table (connect-pg-simple schema).
//         Works when the app stores sessions in Postgres; apps on the
//         default MemoryStore need the 'login' strategy instead.
//     strategy 'login'      drive the app's own login/register endpoint once
//         at boot (body values may reference $SEED rows) and reuse the
//         Set-Cookie it returns.
const crypto = require('crypto');
const { withDb } = require('./db');
const { resolveDeep } = require('./seed');

// express-session cookie format: "s:<sid>.<hmac-sha256(sid, secret)>",
// URL-encoded on the wire.
function signSid(sid, secret) {
  const sig = crypto.createHmac('sha256', secret).update(sid).digest('base64').replace(/=+$/, '');
  return encodeURIComponent(`s:${sid}.${sig}`);
}

async function establishExpressSession(auth, ctx) {
  const name = auth.cookie?.name || 'connect.sid';
  const secret = auth.cookie?.secret || ctx.env.SESSION_SECRET || 'dummy';
  const sid = crypto.randomBytes(16).toString('hex');
  // Session payload: the config's template with $SEED refs resolved, e.g.
  // { user: { user_id: "$SEED.user_data[0].user_id" } }.
  const sess = {
    cookie: { originalMaxAge: null, expires: null, httpOnly: true, path: '/' },
    ...resolveDeep(auth.session || auth.as || {}, ctx.seeded),
  };
  if (!ctx.coords) throw new Error("auth strategy 'express-session' needs a provisioned database (db.kind postgres).");
  const table = /^[A-Za-z_][A-Za-z0-9_]*$/.test(auth.cookie?.table || '') ? auth.cookie.table : 'session';
  await withDb(ctx.coords, async (query) => {
    // connect-pg-simple's schema; created here in case the app relies on
    // createTableIfMissing and hasn't booted its store yet.
    await query(
      `CREATE TABLE IF NOT EXISTS "${table}" (
         "sid" varchar NOT NULL COLLATE "default",
         "sess" json NOT NULL,
         "expire" timestamp(6) NOT NULL,
         CONSTRAINT "${table}_pkey" PRIMARY KEY ("sid"))`
    );
    await query(
      `INSERT INTO "${table}" ("sid", "sess", "expire") VALUES ($1, $2, now() + interval '7 days')
       ON CONFLICT ("sid") DO UPDATE SET "sess" = EXCLUDED."sess", "expire" = EXCLUDED."expire"`,
      [sid, JSON.stringify(sess)]
    );
  });
  return { cookies: [`${name}=${signSid(sid, secret)}`] };
}

async function establishLogin(auth, ctx) {
  const login = auth.login || {};
  if (!login.path) throw new Error("auth strategy 'login' needs auth.login.path.");
  const body = resolveDeep(login.body || {}, ctx.seeded);
  const asJson = login.type === 'json';
  const res = await fetch(ctx.upstreamOrigin + login.path, {
    method: login.method || 'POST',
    headers: { 'Content-Type': asJson ? 'application/json' : 'application/x-www-form-urlencoded' },
    body: asJson ? JSON.stringify(body) : new URLSearchParams(body).toString(),
    redirect: 'manual',
  });
  const cookies = res.headers.getSetCookie().map((c) => c.split(';')[0].trim()).filter(Boolean);
  if (!cookies.length) {
    throw new Error(`Login bootstrap got no Set-Cookie from ${login.method || 'POST'} ${login.path} (status ${res.status}).`);
  }
  return { cookies };
}

// → { cookies: ['name=value', …], headers: {…} } or null.
async function establish(config, ctx) {
  const auth = config.auth || {};
  if (!auth.mode || auth.mode === 'none') return null;
  if (auth.mode === 'header') return { headers: auth.headers || {} };
  if (auth.mode === 'session-cookie') {
    const strategy = auth.cookie?.strategy || 'express-session';
    if (strategy === 'login') return establishLogin(auth, ctx);
    return establishExpressSession(auth, ctx);
  }
  return null;
}

module.exports = { establish, signSid };
