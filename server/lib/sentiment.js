// Lexicon sentiment for tester free text (SEQ comments, post-test notes).
// Deliberately *not* AI — spec §7 defers synthesis precisely because a model
// hallucinates confidently on 3 sessions. VADER is a dictionary: every word
// carries a pre-scored polarity, and a few grammar rules (negation,
// intensifiers, caps/punctuation, contrastive "but") adjust the sum before it
// is normalized into `compound`. Same text always scores the same, offline, in
// microseconds.
//
// Its blind spot is mixed sentiment — "a nightmare to find, but it worked
// great" lands net-positive because the second clause is weighted higher. The
// results page frames the badge as a sorting aid, not a verdict, for that
// reason. Words outside the lexicon (much usability vocabulary: "clunky",
// "unintuitive", "nightmare") contribute nothing, so a genuinely unhappy
// comment can score a flat 0.
const { SentimentIntensityAnalyzer } = require('vader-sentiment');

// VADER's conventional buckets: anything inside ±0.05 is noise, not signal.
const NEG = -0.05;
const POS = 0.05;

// Normalized polarity in [-1, +1], or null when there is nothing to score.
function score(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return null;
  return SentimentIntensityAnalyzer.polarity_scores(s).compound;
}

// 'negative' | 'neutral' | 'positive', or null for an unscored comment.
function label(compound) {
  if (compound == null) return null;
  if (compound < NEG) return 'negative';
  if (compound > POS) return 'positive';
  return 'neutral';
}

module.exports = { score, label, NEG, POS };
