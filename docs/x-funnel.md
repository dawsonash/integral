# The X account as a funnel

Draft v0.1 — 2026-08-05. Companion to `docs/go-to-market.md`, which covers what to build;
this covers how anyone finds out.

## The idea in one line

Turn the X profile into a **satire-startup humour account whose punchlines are playable** —
every joke is a real, working fake startup, and every fake startup is a live Integral test.
The bit is the top of the funnel; the test is the product demo; the results thread is the
proof.

## Why this shape and not "post about the product"

`docs/go-to-market.md` already names the wedge: *"The product demos itself in 2 minutes —
that's the wedge. Show, don't claim."* An account that posts screenshots of a usability
dashboard is claiming. An account that posts *"I built a dating app for horses, here is
Kevin, temperament score 2.3, escapes YTD 14, go book him a date"* is showing — and the
showing happens to be instrumented.

The mechanism is the one already written down in `harnessly-demo/docs/launch-post.md`: the
joke removes the social brake that stops people clicking a founder's link, and the click
lands them *inside* the product rather than on a pitch for it. Nobody has to be persuaded
that session replay is useful; they generate a session and then read their own.

The account works because of a constraint, not despite one: **each artifact yields three
posts, not one.** The bit, the invitation, and the numbers. The third one is the only
advertisement, and it only exists because the first two were funny enough to get takers.

## Profile

**Display name:** `Dawson — Integral`
Keeps a human name attached. A pure brand account posting jokes about fake startups reads
as a content-marketing operation; a person who keeps building these reads as a person.

**Bio** (160 chars — pick one):

> I build fake startups and then run real usability tests on them. Some are broken on
> purpose. Occasionally one is a dating app for horses. → integralco.us

> Fake startups, real usability data. Every joke below is a working app you can break
> yourself. Building @ integralco.us

The first is better: "broken on purpose" is the hook that makes someone read the next post,
and "occasionally one is a dating app for horses" is the specific detail that earns a
follow.

**Location:** `Wexcombe Stables` — a small, load-bearing joke for anyone who took the
Fetlock test, invisible to everyone else. Optional; drop it if it reads as try-hard.

**Link:** `integralco.us` — see *Attribution* below, the link needs tagging.

## Pinned post

The anchor that makes every later joke legible. Without it a new visitor sees a horse app
and bounces.

> I build deliberately terrible startups so I have something to test.
>
> **Harnessly** — an "agentic observability control plane" with an Agent Health Score of
> 94. Ninety-four what? Nobody knows. I wrote it.
>
> **Fetlock** — a dating app for horses. This one is genuinely good, which is the joke.
>
> Each one is a live usability test. Two minutes, no signup, completely anonymous. I post
> the results — success rates, drop-off, and heatmaps of everyone rage-clicking things I
> made deliberately non-interactive.
>
> The tool doing the measuring is [Integral](https://integralco.us). That's the whole
> pitch: I point it at a bad app and it tells me which parts are bad and in what order.
>
> Start here → **[Fetlock link]**

Pin Fetlock, not Harnessly. Fetlock is the polished one and makes a better first
impression on someone who has never heard of any of this; Harnessly rewards a second
visit.

## The recurring format

Three posts per artifact, spaced out:

1. **The bit** (day 0). A specific, quotable detail. Never a description of the app —
   *"Kevin is a 10.2hh Shetland stallion. Temperament score 2.3. Escapes YTD: 14."* Ends
   with the test link. Screenshot attached.
2. **The nudge** (day 1–2). One reply or quote-post with a second detail and a soft count:
   *"41 people have now booked a date for a horse. The 17.2hh Shire is doing better than
   expected."*
3. **The numbers** (day 3–5). The results thread. Real figures, unrounded. This is the
   only post that sells the tool, and it earns the right to by being specific.

Rough cadence: one artifact per 2–3 weeks. Filler between: single-screenshot posts of
individual horse records, planted-flaw postmortems from Harnessly and Reclaim, and
"guess the success rate" polls before a results thread.

## What makes the results thread work

Do not round in your favour. A bad number is a better advertisement for a testing tool
than a good one — it demonstrates the tool found something. The one exception is Fetlock,
where a *high* number is the point, and it is only meaningful stated next to a low one:

> Same tool, two apps. 34% on the one I broke on purpose. 91% on the one I didn't.
> That gap is the entire product.

That comparison is the strongest single asset the account has, and it only exists because
there are three artifacts rather than one.

## Art direction — banner and avatar

I can spec these but not reliably produce them; hand to a designer or build in Canva.

**Avatar.** The `◱ Integral.` wordmark reduced to the mark alone: `◱` in accent orange
`#c2410c` on the off-white `#f7f7f8`, generous padding, no border. It must survive being
rendered at 32px in a timeline, so nothing thinner than ~8% of the frame.

**Banner** (1500×500). Off-white `#f7f7f8` ground, near-black `#1a1a2e` type, one orange
accent. Three device-frame cards in a shallow left-to-right stagger — Harnessly's dark
indigo dashboard, Fetlock's dusk-green card deck, Reclaim's light expense form — each
overlaid with a small orange click-heatmap bloom. Set to the right, in 1a1a2e:

> **Fake startups. Real usability data.**

The visual argument is three obviously-different products carrying the same orange
instrumentation. Keep the safe zone clear: the avatar covers the lower-left ~180px and
mobile crops the outer thirds hard.

**Do not** put a screenshot of Integral's dashboard on the banner. The account's premise
is the artifacts; the tool is the punchline, not the poster.

## Attribution — tag every link

`server/lib/attribution.js` resolves `utm_source` first, then falls back to the referrer
hostname, then `direct`. Untagged, X traffic **splits across two buckets** — `x.com` for
direct clicks and `t.co` for anything routed through X's wrapper — and neither is
obviously X in the dashboard.

So every link, including the one in the bio:

```
https://app.integralco.us/t/<id>?utm_source=x&utm_campaign=<artifact>
https://integralco.us/?utm_source=x&utm_campaign=bio
```

First touch wins and the cookie lasts 30 days, so a visitor who arrives via a Fetlock post
and signs up three weeks later still attributes to `x` / `fetlock`. Campaign values worth
keeping distinct: `fetlock`, `harnessly`, `reclaim`, `bio`, `pinned`.

Worth doing at some point, not required for this: normalise `t.co → x` in
`attribution.js`'s referrer branch, so untagged clicks stop landing in their own bucket.
Note that `report()`'s shape is now spread alongside `views` in
`routes/auth.js#/api/attribution`, so any change there has to keep that key layout.

## Before posting anything

- **Check the response cap and the plan.** The account is currently `unlimited`, so the
  free tier's 1-live-test and 25-responses limits do not apply — but the per-test
  `response_cap` still auto-closes a test when it is hit. All three are set to 200.
- **Free-tier link TTL does not apply either**, but if the plan ever lapses, live links
  start expiring after 14 days. Check before a launch, not after the post is climbing.
- **Discard the setup verification sessions first.** Each of the three tests has one
  session whose SEQ comment reads `SETUP VERIFICATION RUN`. They are real completed
  sessions and will skew a small-N success rate.
- **Read the SEQ comments before trusting the sentiment badges.** Integral scores them
  with a VADER lexicon that inverts ordinary usability phrasing — "dead simple", "sick UI",
  "this is insane" all score backwards. X replies are close to the worst case, since the
  register is almost entirely ironic.

## The three live tests

| Artifact | What it is | Link |
|---|---|---|
| **Fetlock** | Dating app for horses. No planted flaws — the control. | `https://app.integralco.us/t/ZfvFfVfiMO` |
| **Harnessly** | Agentic observability control plane. Six planted flaws. | `https://app.integralco.us/t/VegP3BRzY0` |
| **Reclaim** | Expense reimbursement. Five planted flaws. | `https://app.integralco.us/t/fcsLfcHqd3` |

Reclaim was built as the *internal* calibration fixture. Posting it publicly changes its
role — once strangers have run it, its numbers stop being a clean baseline for measuring
the instrument. That is a real trade and probably still worth making, since three
artifacts make the comparison argument far stronger than two. But keep a private note of
the pre-launch figures before the first public session lands.
