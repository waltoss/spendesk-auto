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
4. ~~Keep the session warm while the laptop is awake~~ — attempted and removed, see §6.
   `StartInterval` cannot fire during sleep, so this could never reach the morning.

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

**Access: Mail.app, via AppleScript. `gws` was tried and removed.**

The Gmail API through the `gws` CLI worked, and was still the wrong dependency. That
credential is shared with unrelated tooling, so re-issuing it for another purpose silently
narrowed the scopes this needed; and the binary moved from an fnm node script to a Homebrew
binary, which broke resolution outright. Because the reader was deliberately fail-soft,
both failures presented identically: *no signals*, indistinguishable from a quiet week.
A source that other work can invalidate without saying so cannot answer "does anything
need me?".

What makes Mail.app viable is a **Gmail-side filter**, `from:spendesk.com → label
Spendesk`, created once. IMAP presents the label to Mail.app as a mailbox of the same name,
so the query targets one small, deterministically-named mailbox instead of scanning every
mailbox of every account. Measured: ~0.8s on a 16-message mailbox, ~3.7s at ~600, against
100s+ for the unified-inbox scan. The expensive predicate — the sender match — has already
been evaluated server-side.

Requirements, learned the hard way:

- **A missing mailbox must raise, not return empty.** A bad mailbox reference returns an
  empty list in ~1.6s with no error, and empty reads as "nothing needs you". `mail.ts`
  returns a sentinel and throws instead.
- **Never launch Mail.app.** A scheduled job that opens a window on a sleeping desk is
  worse than no signal. It checks whether Mail is already running and declines otherwise.
- **`signals: null` is not `signals: []`.** With no second source there is nothing to
  cross-check against, so "could not look" is encoded in the type and reported as a
  failure, never as an all-clear.

Historical note, kept because it justifies the decision: an earlier broader Google grant
died with `invalid_grant: invalid_rapt` — Google's ReAuth Proof Token, tied to the
Workspace admin's Cloud session-length policy. Removing the Google dependency removes that
class of expiry from the fast path entirely; the Gmail filter is server-side and needs no
token at run time.

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

## 6. Keep-warm: removed

Built, scheduled (`StartInterval 1800`, `RunAtLoad`) — and it never ran once. `runs = 0`,
`pended nondemand spawn = speculative`, no `warm.log` ever created.

The reason not to debug it is in `man launchd.plist`:

> **StartInterval** — If the system is asleep during the time of the next scheduled
> interval firing, that interval will be missed due to shortcomings in kqueue(3).

The session lives 60 minutes. The laptop sleeps overnight. So even a working keep-warm
could not carry a session to morning: it was written to solve the one problem its own
primitive cannot solve. Deleted rather than fixed.

The contrast matters, because the daily job uses the other key:

> **StartCalendarInterval** — Unlike cron which skips job invocations when the computer is
> asleep, launchd will start the job the next time the computer wakes up. If multiple
> intervals transpire before the computer is woken, those events will be coalesced into one
> event upon wake from sleep.

So the trigger is solved: open the Mac at 09:15 and the 08:00 job runs, once, on wake.
What is not solved is that it wakes into a dead session — see §7.

## 7. What to build

1. ~~**Gmail reader**~~ — **done**, as `src/signals/mail.ts` + `src/signals/classify.ts`.
   Reads the labelled mailbox from Mail.app; the subject parsing is pure and tested apart
   from any client.
2. **Session-free `check`** — **done**. Leads with the email answer before it opens a
   browser, so the common question costs no login. Exit 0 = nothing needs you.
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
