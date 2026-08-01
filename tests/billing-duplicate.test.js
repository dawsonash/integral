const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.INTEGRAL_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'integral-dup-test-'));

const { hasLiveSubscription, ACTIVE_STATUSES } = require('../server/routes/billing');

// Only subscriptions.list is reached; `calls` lets the tests assert how it was
// queried, since asking for a single status would silently miss the others.
function fakeStripe(statuses) {
  const calls = [];
  return {
    calls,
    subscriptions: {
      list: async (args) => {
        calls.push(args);
        return { data: statuses.map((status, i) => ({ id: `sub_${i}`, status })) };
      },
    },
  };
}

test('a customer with nothing on file is not blocked', async () => {
  assert.equal(await hasLiveSubscription(fakeStripe([]), 'cus_1'), false);
});

test('every current status blocks a second checkout', async () => {
  for (const status of ACTIVE_STATUSES) {
    assert.equal(await hasLiveSubscription(fakeStripe([status]), 'cus_1'), true, `for ${status}`);
  }
});

test('past_due blocks — dunning has not ended, so access has not lapsed', async () => {
  // Guards the intent behind including it: a customer mid-dunning still has the
  // plan, and letting them buy a second one is the double charge we are here to
  // prevent.
  assert.ok(ACTIVE_STATUSES.includes('past_due'));
  assert.equal(await hasLiveSubscription(fakeStripe(['past_due']), 'cus_1'), true);
});

test('dead subscriptions do not block a genuine re-subscribe', async () => {
  const dead = ['canceled', 'incomplete_expired', 'unpaid'];
  assert.equal(await hasLiveSubscription(fakeStripe(dead), 'cus_1'), false);
});

test('an incomplete checkout does not block a retry', async () => {
  // The card failed and no subscription ever started; refusing here would strand
  // the customer with no way to buy.
  assert.equal(await hasLiveSubscription(fakeStripe(['incomplete']), 'cus_1'), false);
});

test('an active subscription is found among cancelled history', async () => {
  const s = fakeStripe(['canceled', 'canceled', 'active']);
  assert.equal(await hasLiveSubscription(s, 'cus_1'), true);
  // status:'all' is what makes that possible — the list endpoint accepts one
  // status, so filtering server-side would have to pick which to miss.
  assert.equal(s.calls[0].status, 'all');
});
