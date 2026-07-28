const { test } = require('node:test');
const assert = require('node:assert');
const { score, label } = require('../server/lib/sentiment');

const bucket = (text) => label(score(text));

test('clear polarity buckets the way a reader would', () => {
  assert.equal(bucket('This was terrible and frustrating.'), 'negative');
  assert.equal(bucket('Loved it, worked perfectly.'), 'positive');
  assert.equal(bucket('I clicked the third item in the list.'), 'neutral');
});

test('nothing to score returns null rather than a fake neutral', () => {
  for (const empty of ['', '   ', null, undefined]) {
    assert.equal(score(empty), null, `${JSON.stringify(empty)} should not score`);
  }
  assert.equal(label(null), null);
});

test('grammar rules move the score, not just the word list', () => {
  // Negation flips, intensifiers deepen, caps + punctuation shout.
  assert.ok(score('good') > 0 && score('not good') < 0, 'negation flips polarity');
  assert.ok(score('very confusing') < score('confusing'), 'intensifier deepens');
  assert.ok(score('CONFUSING!!') < score('confusing'), 'caps and !! intensify');
});

test('compound stays inside [-1, +1]', () => {
  const shouty = score('AWFUL AWFUL AWFUL, terrible, horrible, the worst!!!');
  assert.ok(shouty >= -1 && shouty <= 1, `${shouty} out of range`);
});

// Documented limitations — pinned here so they are a known cost, not a
// surprise. Both are why the results page calls the badge a sorting aid.
test('KNOWN LIMIT: a "but" clause outweighs the complaint before it', () => {
  const mixed = 'the button was a nightmare to find, but once I did it worked great';
  assert.equal(bucket(mixed), 'positive');
});

test('KNOWN LIMIT: usability vocabulary outside the lexicon scores flat neutral', () => {
  // "nightmare", "clunky", and "unintuitive" are absent from VADER's
  // social-media-derived lexicon, so genuine complaints can land at 0.
  assert.equal(bucket('the checkout flow was clunky and unintuitive'), 'neutral');
  assert.equal(bucket('I expected a buy button on the product itself.'), 'neutral');
});
