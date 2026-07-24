const { test } = require('node:test');
const assert = require('node:assert');
const { isDynamicSegment, normalizePage, groupPages } = require('../server/lib/screens');

test('dynamic segments: ids collapse, route words survive', () => {
  // Collapse: things that look like row ids.
  for (const seg of [
    '123',
    '0',
    '550e8400-e29b-41d4-a716-446655440000',
    'deadbeefdeadbeef',
    'a1b2c3d4e5f6g7h8i9j0k1l2', // long random token with digits
  ]) {
    assert.ok(isDynamicSegment(seg), `${seg} should be dynamic`);
  }
  // Survive: route words, versions, filenames, short slugs.
  for (const seg of ['search', 'login', 'v2', 'index.html', 'events', 'new', 'user-settings']) {
    assert.ok(!isDynamicSegment(seg), `${seg} should NOT be dynamic`);
  }
});

test('normalizePage collapses route ids but never touches the DOM-screen part', () => {
  assert.equal(normalizePage('event/123'), 'event/{id}');
  assert.equal(normalizePage('user/550e8400-e29b-41d4-a716-446655440000/friends'), 'user/{id}/friends');
  assert.equal(normalizePage('search'), 'search');
  assert.equal(normalizePage(''), '');
  assert.equal(normalizePage('index.html::Checkout 2024'), 'index.html::Checkout 2024');
  assert.equal(normalizePage('event/42::Payment'), 'event/{id}::Payment');
});

test('groupPages aggregates counts and picks the busiest concrete as representative', () => {
  const groups = groupPages([
    { page: 'event/1', count: 2 },
    { page: 'event/2', count: 7 },
    { page: 'search', count: 3 },
  ]);
  const ev = groups.find((g) => g.key === 'event/{id}');
  assert.equal(ev.count, 9);
  assert.equal(ev.representative, 'event/2');
  assert.deepEqual(ev.concretes.sort(), ['event/1', 'event/2']);
  const se = groups.find((g) => g.key === 'search');
  assert.equal(se.count, 3);
  assert.equal(se.representative, 'search');
});
