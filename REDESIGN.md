# Redesign — minimise re-login

Status: **proposed**, 2026-09-02. Companion to [DESIGN.md](DESIGN.md), which stays the
reference for everything not changed here.

The system works. This is about the one thing that makes it unpleasant to live with.

---

## 1. The problem

The Spendesk session lasts **60 minutes** and cannot be refreshed by us. So a job that runs
once a day always finds a dead session, degrades to the payable path, and asks for a login.

The goal is not "never log in". Writing a description genuinely requires a session and
there is no public endpoint for it. The goal is narrower and achievable:

> **Never log in merely to discover that nothing needs doing.**

Most mornings the honest answer is "you're fine". That answer must cost zero logins.

## 2. What was measured (2026-09-02)

| fact | value | how |
|---|---|---|
| `SPX_ACCESS_TOKEN` TTL | **60 min** | decoded the JWT `iat`/`exp` |
| `SPX_REFRESH_TOKEN` TTL | **600 min** | same |
| refresh endpoint | **not found** | 9 candidate paths, app bundle grep, HAR of a full session |
| tokens are IP-bound | `ip`, `refreshTokenIp` claims | JWT |
| authorization → payable materialises | median **41.2h**, p90 58.2h, max 69.7h | n=58, `payment.created_at` → `payable.firstCreatedAt` |
| purchase email latency | **~3 seconds** after authorization | €406.98: email 20:15:12, `created_at` 20:15:09 |
| block-warning email | daily batch at **07:04 UTC**, 24h notice | 4 samples over 45 days |

Three earlier figures in DESIGN.md were wrong and are superseded: "4 re-logins a year"
(read cookie expiry, not token expiry), "fortnightly" (one idle sample), and "payable
appears on day 2 / p75 3.17 days" (measured from a midnight-truncated `creationDate`,
inflating every lag by ~24h). **Do not reuse them.**

The tail matters more than the median: at 69.7h against a ~72h fuse, the slowest payables
leave ~2h. Card-present spend (restaurants, taxis) clears slowest, so the expenses that
most need a human decision arrive with the least time to make it.

## 3. The change

Split the run by **what a step needs**, not by what it does.

```
   session-free                                  session-gated
   ─────────────────────────────────────         ──────────────────────────
   Gmail: purchase emails      (day 0)           description  (internal PUT)
   Gmail: "blocked in 24h"     (07:04 UTC)       any write before ~41h
   public API: payables        (~41h)
   public API: PATCH fields    (~41h)
   public API: attach receipt  (~41h)
                    │                                      │
                    └──────────► digest ◄──────────────────┘
                                   │
                    "nothing needs you"   or   "these need you, and here's why"
```

Rules:

1. **`check` never opens Spendesk.** It answers "do I need to act?" from Gmail and the
   public API only. If it cannot answer, it says so rather than prompting for a login.
2. **Attempt every session-free write first.** Fields and receipts land without a session
   once the payable exists.
3. **Ask for a login only when something is actually blocked on it**, and say what. Never
   "please authenticate" with no reason.
4. **Keep the session warm while the laptop is awake** so that a login made at 09:00 is
   still good at 18:00.

## 4. Signals from Gmail

Session-free, and better than anything we derive ourselves.

| subject | meaning | timing |
|---|---|---|
| `New purchase of €X made with your Spendesk card` | a transaction exists | authorization + 3s |
| `… charged €X for your subscription` | subscription-bound; description likely inherited | same |
| `Your account will be blocked in 24h due to missing receipts…` | **the real deadline, from Spendesk** | 07:04 UTC daily |
| `Your payment of €X was declined` | the SLA already failed | at the terminal |

The block-warning email replaces our inferred 72-hour fuse. It is authoritative, needs no
login, and gives 24 hours' notice.

The decline emails are the only honest success metric: **declines per month, before and
after**. Three in the last 45 days.

**Trap: email amounts are the billed EUR amount, not the native one.** A USD 22.00 Cursor
charge arrives as "New purchase of €19.00". So matching an email to a payment must use
`functionalAmount` (payable) or `amount_billed` (payment) — never `amount` /
`amount_declared`. This is the opposite of the rule for matching *invoices*, where DESIGN
§8.6 requires the native amount because EUR moves with FX. Both rules are right, for
different joins.

**Access: `gws`, scoped to `gmail.readonly` only.** It is the Gmail API with credentials
already provisioned in a GCP project inside the theodo.fr org, which means the consent
screen can be Internal — no 7-day refresh-token expiry, no Google verification for a
restricted scope. Verified least-privilege: Gmail succeeds, Drive returns
`insufficientPermissions`.

Two implementation requirements, both learned the hard way:

- **Resolve the binary durably.** The `gws` on an interactive PATH lives in
  `~/.local/state/fnm_multishells/<pid>_<timestamp>/bin`, one of ~2000 per-shell
  directories that do not exist for a launchd job. Use
  `~/.local/share/fnm/node-versions/*/installation/bin/gws`, newest first, and put that
  directory on `PATH` for the child — `gws` is a node script and needs its own `node`.
- **Never run it with a stripped environment.** With `env -i` it cannot reach the keychain,
  fails to decrypt, and *deletes* `credentials.enc`, forcing an interactive re-login.

**Open: does the grant survive?** A previous broader grant died with `invalid_grant:
invalid_rapt` — Google's ReAuth Proof Token, which is tied to the Workspace admin's Cloud
session-length policy. The hypothesis is that a Gmail-only grant is not subject to it. That
is unverified: if Theodo enforces reauth across all OAuth grants, Gmail needs periodic
interactive login too, and the session-free path is not actually session-free. **Watch for
a recurrence over the coming days before relying on this.**

**Caveat on the subscription subject line.** It agreed with `subscription_id` on 45 of 46
payments, but the one mismatch (€135.61) over-claimed — email said subscription, the API
said not. That is the unsafe direction: trusting it would silently skip a payment that
needed work. Treat it as a hint. What actually matters is whether `description` is present,
and the public API answers that directly once the payable exists.

## 5. Subscriptions — a lever, with a real price

Payments linked to a subscription arrive with the description already filled, inherited
from the recurring request. All four subscription-bound payments in the sample were
described; the text repeats verbatim across months.

That would remove descriptions — the only session-gated write — from the automatable set.

**But converting is not a config change.** Per vendor it needs a request to the admin team,
their approval, and updating the card number at the provider. So this is a per-vendor
judgement, not a blanket recommendation:

- **Worth it** for charges that recur indefinitely and never need a human: GCP billing
  accounts, Cursor, OpenAI, Anthropic. Pay the cost once, and they complete themselves
  forever.
- **Not worth it** for anything ad hoc.

Meals, taxis and hotels can never be subscriptions, will always lack a description, and
will always need a reply about who and why. **The logins they force are logins that were
going to happen anyway** — which is the acceptable end state, not a failure.

Evidence is n=4 and the mechanism is unconfirmed. **Verify before paying the conversion
cost**: open the LLM Gateway subscription and check the description lives on the
subscription itself rather than being copied once.

## 6. Keep-warm, and its limit

Built and scheduled (`keep-warm`, `com.theodo.spendesk.warm`, `StartInterval 1800`).

It keeps the session alive through a working day, so one login in the morning lasts until
evening. **It cannot survive sleep**: launchd does not fire during sleep, it runs missed
jobs on wake. Eight hours overnight will always kill the session.

So: keep-warm removes logins *during* the day. It does not remove the morning one. Only
§3's split removes that, by not needing a session to answer the common question.

Unverified as of writing: whether 30 minutes is enough, and whether the session survives
indefinitely with pinging or dies at the 600-minute refresh-token ceiling regardless.
`logs/runs.jsonl` records every ping gap (`warm`) and every death (`went-cold`) — read it
before tuning the interval.

## 7. What to build

1. **Gmail reader** — `src/signals/gmail.ts`. Parse the four subjects above into typed
   events. `gws` is already installed and authenticated; treat its token as short-lived and
   fail soft, because this must never be the reason a run dies.
2. **Session-free `check`** — answers from Gmail + public API, never opens a browser.
   Exit 0 = nothing needs you.
3. **Re-order `run`** — session-free writes first, session-gated work batched and only
   attempted if a session already exists. Never open a login window from a scheduled run.
4. **Digest rewrite** — lead with the deadline from the block-warning email. Ask for a
   login only with a reason attached.
5. **Cache the control rules** — snapshot `control-rules/actively-used` and `custom-fields`
   whenever a session is up, so the session-free path evaluates real rules instead of the
   current hardcoded three-field approximation, which over-reports (one GCP payment
   required none, another required two).

Not worth building, considered and rejected:

- **Webhooks** (`payables-created`, `settlement-created` exist). They need a public HTTPS
  endpoint — the hosted component the design rejects — to save ~2h out of a ~38h margin,
  because the payable is minted at 03:47 UTC and the job runs 06:00 UTC.
- **`/v1/transactions/successful`** and **`/v1/settlements`** (403; need
  `experimental:transaction:read` / `settlement:read`). Both improve *detection* only,
  neither carries a `paymentId`, and Gmail already detects earlier and for free. Cheap
  read-only scopes to ask for, but they change nothing structural.

## 8. Open questions

- Does the session survive indefinitely with 30-minute pings, or cap at the 600-minute
  refresh-token TTL? **Read `runs.jsonl`.**
- Is there a refresh endpoint? Not found by guessing, bundle-grepping, or a full-session
  HAR. The remaining honest route is capturing the SPA's own refresh while the app is open
  past minute 55.
- Does completing a *payment* before its payable exists carry over when the payable is
  minted? Both GCP charges were completed on 2026-09-02 with the payable due ~03:47 on
  09-03. **Check those two first** — if it does not carry over, the day-0 path is worth
  much less than assumed.
- Do the meal reply-parsing regexes work? Still never tested against a real reply.
