# Design Spec — Usability Testing for Developers (Integral)

> Status: Draft v0.1 — trunk decisions resolved via grilling session (2026-07-05).
> This document captures the decisions and, deliberately, the reasoning and rejected
> alternatives behind them, so future scope changes can be checked against intent.

---

## 1. Positioning

A **low-ceremony usability-testing tool for developers**. The wedge is:

> "Test the slice you just built in ~2 minutes, from a link, without a research team."

**Primary buyer:** the individual developer testing their own work. Explicitly *not* a
designer/PM/UX-research suite — that market is served by heavier incumbents (Maze,
UserTesting, Lookback), and competing there would force ceremony that kills the wedge.

**Design filter for every feature:** *"Would a developer bother, or just ship it?"*
Ceremony is the enemy. Each added sensor, permission prompt, or config step must earn
its friction.

---

## 2. The Keystone Decision

**You are the runtime.** The testee is always on `ourtool.com`. We ingest the dev's
front-end *artifact*, host it **same-origin** on our own infrastructure, inject an
rrweb-style recorder directly, and populate seed data as needed so the flow "works."

Same-origin hosting is **load-bearing** — it is the single technical choice that makes
recording actually work. It is *why* several things are deferred (see §7). Any future
ingestion source must be reducible to "self-contained content we can serve same-origin,"
or recording breaks.

### Rejected alternatives (and why)
- **Cross-origin iframe of the dev's live app** — browser same-origin policy blocks
  reading the DOM / mouse / keyboard inside a cross-origin frame, and most real apps send
  `X-Frame-Options`/`frame-ancestors` so the frame won't even load. Recording captures
  nothing. **Dead on arrival for real apps.**
- **Reverse proxy** ("zero install, paste any URL") — man-in-the-middling a real app
  breaks on auth, cookies, CSP, CORS, absolute URLs, SPA routing. A reliability sink and a
  security-review red flag.
- **Injected snippet in the dev's real deployed app** — works, but pulls us into real
  backends/auth and is a different (heavier) product than "host the slice."
- **Real component isolation (Storybook-style)** — the multi-year mocking/context problem;
  fights the low-ceremony wedge.

---

## 3. Core Loop (v1)

1. **Ingest** — dev adds a self-contained front-end artifact (drag-drop folder/zip, or
   paste raw HTML).
2. **Host** — we serve it same-origin and inject the recorder.
3. **Set up** (visual, point-and-click, target <2 min):
   - set the **start screen** (multi-screen flows are in scope),
   - **click the success target** element/screen → captured as the completion signal
     (we infer a stable selector; no hand-written selectors or config files),
   - write the **task prompt**, plus optional post-task SEQ and optional one-question
     screener.
4. **Share** — dev gets an **open shareable link**, sends it anywhere (bring-your-own
   testers).
5. **Test** — anonymous testee passes a one-tap **consent gate**, performs the task; we
   capture the session and **auto-detect success**.
6. **Report** — dev gets a metrics dashboard + attention heatmap + session replays.

---

## 4. What We Capture (v1)

| Signal | v1 | Notes |
|---|---|---|
| Mouse / touch / click / scroll | ✅ always on | Full rrweb-style session replay |
| Keyboard **content** | 🔒 masked by default | Dev can selectively un-mask known-safe fields (e.g. a search box) |
| Keyboard **behavior** (hesitation, backspaces, corrections) | ✅ always on | Preserved even on masked fields — the "why" without the PII |
| Task **success** | ✅ auto-detected | Dev-designated target → success rate |
| **Time-on-task** | ✅ | Derived from start→success |
| Post-task **SEQ** (Single Ease Question, 1–7) + free-text comment | ✅ | Near-zero friction; pairs subjective score with objective success |
| Think-aloud **audio** | ❌ v1 | Optional per-test later; mic prompt lowers completion |
| **Webcam** video | ❌ v1 | Only ever as carrier for eye-tracking (v2, paid panel) |

**Permission philosophy:** v1 fires **zero** browser permission prompts. Every prompt is a
completion cliff for unpaid, cold link-clickers.

---

## 5. Testee Experience & Data Quality (v1)

- **Anonymous** — no login (an account requirement would gut completion).
- **Consent gate** — one line before start: "This session is recorded for usability
  research. Continue?" Legally necessary and trust-building.
- **Open link + dev-set response cap** — anyone can take it until N completes, then
  auto-closes. Caps cost and noise.
- **Auto-discard junk** — sessions with no interaction or completed in <Xs (bots /
  rage-quits) are filtered before they pollute metrics.
- **Fingerprint dedupe** — one response per device.
- **Optional one-question screener** — cheap stand-in for targeting until the v2 panel.
- **Honest labeling** — results are labeled **"unscreened sample."** BYO samples are the
  dev's followers, *not* the dev's users — inherently biased. The paid panel (v2) is the
  only real fix; the UI must not let anyone over-trust an n=12 Twitter test.

---

## 6. Output (v1)

Layered **metrics dashboard + replays**:
- **Task success rate** and **time-on-task** distribution
- **SEQ** distribution + free-text comments
- **Attention heatmap** derived from mouse-movement / hover / **scroll-depth** — a
  frictionless, permission-free proxy for gaze (stands in for eye-tracking in v1)
- **Drop-off / where-they-got-stuck**
- **Session replays** for drill-down and proof

AI friction-synthesis is deferred to v2 (see §7).

---

## 7. Deliberately Deferred (v2+)

Each of these was cut from v1 because it carries disproportionate cost or fights the wedge.

| Deferred item | Why deferred |
|---|---|
| **Real GitHub-repo ingestion** | Two hard problems at once: (1) build an arbitrary repo — the *Vercel problem*; (2) answer its network calls with seed data — the *MSW/mocking problem*. ~90% of total eng cost lives here. |
| **Figma source** | A live Figma embed is cross-origin → breaks recording. Same-origin Figma requires building a **custom prototype player** fed by Figma's REST API (frame images + interaction graph). Real, scoped work → **fast-follow**, not blocker. |
| **Paid "random users" panel** | A two-sided **marketplace** = a second company: cold-start, tester quality/fraud control, identity, global payments/tax, cash-intensive. This is the eventual money-maker but must not be built first. |
| **AI friction-synthesis** | High-value hero output later ("don't watch anything — here's what went wrong"). Risk: confident hallucination on thin data (2–3 sessions). Needs data volume + honest confidence framing first. |
| **Webcam eye-tracking** | Browser-only = webcam gaze estimation: coarse (region-level), per-session calibration ritual, degrades with lighting/glasses/head-movement. Needs a camera prompt + patient tester → only viable with the **paid, screened panel**. Ships as top premium tier in v2. |
| **Think-aloud audio** | Optional per-test depth feature; mic prompt lowers completion. |

**Phasing logic:** prove the record → recruit → analyze loop on trivially-hostable,
backend-free sources first. Every deferral traces back to protecting either the
low-ceremony wedge or the same-origin keystone.

---

## 8. Monetization

**v1: Freemium.**
- **Free tier** — generous enough to reach the "aha" (run a real test, see real friction
  data). Small number of active tests, monthly response cap, shorter data retention.
- **Paid tier** (~$19–39/mo, indie-friendly) — gated on **volume + retention + seats**, the
  axes that scale with a dev getting value.

Rationale: build billing muscle and learn conversion *before* the expensive v2 features
land. Avoid "free forever" — it trains a dev audience to expect a free toy and makes later
re-pricing painful.

**v2 premiums stack on the paid ladder:** paid panel (per-response fee) · AI synthesis
(higher tier) · eye-tracking (top tier).

---

## 9. Key Risks (carried knowingly)

1. **Thin v1 differentiation.** Until AI synthesis + panel land, this is "task-based
   session replay." The 2-minute setup + auto success-rate/time-on-task is the wedge —
   must be enough to pull devs off free tools (Loom, PostHog replay).
2. **Sample bias.** BYO open-link samples ≠ real users. Mitigated only by honest labeling
   in v1; fixed properly by the v2 panel.
3. **Same-origin fragility.** Every source must reduce to self-contained hostable content.
   This constraint is the reason for the v1 source list — guard it when adding sources.
4. **AI-on-thin-data (v2).** Summaries of 2–3 sessions will hallucinate confidently.
   Requires explicit "directional only, n=3" framing.

---

## 10. Open Questions (smaller — not yet grilled)

- Exact data-retention windows per tier (free vs paid).
- Tech stack (recorder: rrweb vs custom; hosting/sandbox model; storage).
- Team / collaboration features (shared workspaces, comments on replays) — in or out of v1?
- Product name.
- Screener depth — single question only, or a small set?
- Success-target robustness — selector stability across artifact re-uploads / edits.
- Multi-screen routing detection — how we identify "screens" in an arbitrary
  self-contained bundle (route changes vs. DOM swaps).

---

## Appendix — Decision Log (trunk)

| # | Branch | Decision |
|---|---|---|
| 1 | Buyer | Individual developer testing own work |
| 2 | Unit under test | Hosted self-contained artifact; testee always on our URL |
| 3 | Recording mechanism | Same-origin hosting + injected rrweb-style recorder |
| 4 | GitHub ingestion | Deferred to v2 (Vercel + MSW problem) |
| 5 | Recruitment | BYO open link (v1); paid panel (v2) |
| 6 | Task & success | Dev designates success target → auto success rate + time-on-task |
| 7 | Capture scope | Interaction replay + post-task SEQ/comment (v1) |
| 8 | Eye-tracking | v2, tied to paid panel; mouse/scroll heatmap in v1 |
| 9 | Output | Metrics dashboard + replays (v1); AI synthesis (v2) |
| 10 | Figma | Fast-follow (needs custom same-origin prototype player) |
| 11 | Privacy | Mask inputs by default + selective un-mask + behavioral timing + consent gate |
| 12 | Link mechanics | Open link + response cap + junk filter + fingerprint dedupe + anonymous + optional screener |
| 13 | Monetization (v1) | Freemium (paid on volume/retention/seats) |
| 14 | Setup UX | Visual point-and-click; drag-drop/paste in; multi-screen flows |
