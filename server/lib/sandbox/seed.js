// Fake seed rows — where the original "Lorem Ipsum per test" idea lives, but
// as database rows instead of rendered placeholders (spec §2). Two modes:
//   faker    seed.tables maps table → { rows, columns } where column values
//            are faker paths ("faker.internet.userName"), $-tokens, or
//            literals; rows are INSERTed and the RETURNING values kept so
//            later config ($SEED.users[0].id) can reference them.
//   command  the dev's own seed script, run with the sandbox env so it hits
//            the ephemeral DB. Best-effort faker can't always satisfy a
//            schema's constraints (§8) — this is the honest fallback.
const { faker } = require('@faker-js/faker');

// "faker.internet.userName" → walk the faker object; only functions at the
// end of a known path are callable, so config can never reach outside faker.
function fakerCall(path) {
  let node = faker;
  for (const part of path.split('.').slice(1)) {
    if (node == null || part.startsWith('_') || part === 'constructor') { node = undefined; break; }
    // faker v10 lowercased several names (userName → username); accept both
    // so spec-era configs keep working.
    node = node[part] !== undefined ? node[part] : node[part.toLowerCase()];
  }
  if (typeof node !== 'function') throw new Error(`Unknown faker generator "${path}"`);
  const v = node();
  return v instanceof Date ? v.toISOString() : v;
}

// One column value for row `i` of a table.
function seedValue(spec, i) {
  if (typeof spec !== 'string') return spec;
  if (spec.startsWith('faker.')) return fakerCall(spec);
  if (spec === '$i') return i;
  if (spec === '$now') return new Date().toISOString();
  return spec;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Insert `tables` in declaration order (put parents before children so FK
// references resolve). Returns { table: [insertedRow, …] }.
async function seedFaker(query, tables) {
  const seeded = {};
  for (const [table, def] of Object.entries(tables || {})) {
    if (!IDENT.test(table)) throw new Error(`Bad table name "${table}" in seed.tables`);
    const columns = Object.keys(def.columns || {});
    if (columns.some((c) => !IDENT.test(c))) throw new Error(`Bad column name in seed.tables.${table}`);
    seeded[table] = [];
    const n = Math.min(Math.max(1, Number(def.rows) || 1), 500);
    for (let i = 0; i < n; i++) {
      const values = columns.map((c) => resolveSeedTokens(seedValue(def.columns[c], i), seeded));
      const placeholders = columns.map((_, j) => `$${j + 1}`).join(', ');
      const cols = columns.map((c) => `"${c}"`).join(', ');
      const { rows } = await query(
        `INSERT INTO "${table}" (${cols}) VALUES (${placeholders}) RETURNING *`,
        values
      );
      seeded[table].push(rows[0] || {});
    }
  }
  return seeded;
}

// "$SEED.user_data[0].user_id" → the value captured at insert time. Used in
// column specs, auth session templates, and env values.
const SEED_REF = /^\$SEED\.([A-Za-z_][A-Za-z0-9_]*)\[(\d+)\]\.([A-Za-z_][A-Za-z0-9_]*)$/;

function resolveSeedTokens(value, seeded) {
  if (typeof value !== 'string') return value;
  const m = value.match(SEED_REF);
  if (!m) return value;
  const row = ((seeded || {})[m[1]] || [])[Number(m[2])];
  if (!row || !(m[3] in row)) throw new Error(`Unresolved seed reference "${value}"`);
  return row[m[3]];
}

// Deep-resolve $SEED tokens inside an object template (auth session bodies).
function resolveDeep(node, seeded) {
  if (typeof node === 'string') return resolveSeedTokens(node, seeded);
  if (Array.isArray(node)) return node.map((v) => resolveDeep(v, seeded));
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = resolveDeep(v, seeded);
    return out;
  }
  return node;
}

module.exports = { seedFaker, seedValue, resolveSeedTokens, resolveDeep };
