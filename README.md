# Spendesk expense automation

Completes your Spendesk expenses before the card gets blocked.

A card transaction has a ~3-day fuse: the payable only appears in Spendesk on day 2, and
on day 3 the card is declined — usually discovered at a restaurant rather than at a desk.
So the actionable window is about 24 hours. This runs every morning, fills everything that
is mechanical, fetches the invoices it can, and sends **one email** about whatever actually
needs a human.

Full reasoning, measurements and API notes: [DESIGN.md](DESIGN.md).

Runtime: **Bun 1.4**, TypeScript throughout, `strict` + `noUncheckedIndexedAccess`. Every
Spendesk response and the rules file are parsed with [zod](https://zod.dev) at the
boundary. Playwright drives the browser — that is deliberate, see *Why Playwright* below.

## Usage

```bash
bun run dry           # decide everything, write nothing — start here
bun start             # the daily job
bun run check         # is the session alive and do the rules still resolve?
bun run reauth        # sign in again (Touch ID + a tap on the Spendesk phone app)
bun run rules:check   # validate config/rules.ts against the live Spendesk schema
bun test              # guards, matching, PDF verification, dashboard refusals
bun run typecheck     # tsc --noEmit

bun run fetch gcp --amount 266.49    # try one vendor adapter on its own
bun run fetch gcp --amount 500 --date 2026-09-25   # a threshold debit (same amount every time)
bun run dashboard     # open http://127.0.0.1:8787/
```

## Dashboard

The trigger listener (`bun run serve`, kept resident by launchd) also serves a dashboard
at <http://127.0.0.1:8787/>:

- **sign-ins**: Spendesk, Google, Anthropic and Cursor, as last recorded in the run log.
  Opening the page probes nothing, because polling payments.google.com is what got the
  account rate-limited (DESIGN §10). "Check sessions" and "Sign in" are buttons;
- **run**: dry run, run now, sign in then run, check rules, list a vendor's invoices. Each
  button starts a job whose output streams to `/jobs/<id>` (kept in `logs/jobs/`). Only one
  runs at a time, because they all share one Chrome profile. A job is also refused while the
  08:00 run holds the profile (Chrome's `SingletonLock`);
- **waiting in Spendesk**: the incomplete payables, read live through the public API (no
  session needed), with what a run would do to each;
- **last run / history**: every run from `logs/runs.jsonl`, and per charge the rule it
  matched, what was written, which invoice was attached and why anything was escalated;
- **invoices** and **rules**: what is in `invoices/`, and the rules as the matcher reads
  them, with how many charges each rule claimed in the last 30 days.

It is loopback-only, and still guarded against the websites you visit. The Host header must
name the listener (against DNS rebinding), buttons must be same-origin with a per-process
CSRF token, and the page refuses to be framed.

## Layout

```
config/rules.ts          the only file to edit for a new supplier or rule
src/
  index.ts               CLI: run | fetch | check | reauth | rules:check | schedule | serve
  run.ts                 the daily job itself (also called by the scheduler)
  trigger.ts             the resident listener: emailed link (/go) + dashboard
  jobs.ts                starts CLI commands from the listener, one at a time
  dashboard/             state (from the run log), live queue, HTML
  job.ts                 Bun.cron entry point (`scheduled()`)
  schedule.ts            launchd vs Bun.cron
  config.ts              loads and validates config/rules.ts
  rules.ts               the matcher — the only interpreter of the rules file
  types.ts               QueueItem / Decision / Result — the discriminated unions
  schemas/
    spendesk.ts          zod schemas for every Spendesk response
    rules.ts             zod schema for the rules file
  spendesk/
    auth.ts              public-API token; session cookie liveness
    queue.ts             payments (GraphQL + oracle) and payables (public API)
    write.ts             buildPatch (the §9 guards, pure) + PATCH/PUT/attachment
    verify.ts            re-read after writing; completionState when a session exists
    schema.ts            resolve field/value labels -> ids; validate the rules file
  vendors/
    index.ts             registry + shared verify (pdftotext, amount assertion)
    cursor.ts  gcp.ts
  browser.ts  reauth.ts  notify.ts  log.ts
test/                 bun:test — guards, rules, PDF verification
```

## Adding a supplier or changing a rule

Edit [`config/rules.ts`](config/rules.ts) — that is the only file you should need to
touch. It is written in the labels you see in Spendesk, never in ids:

```ts
{
  name: "Cursor",
  when: { supplier: /^cursor$/i },
  fields: { "Catégorie de dépense": "IT Costs" },
  description: ({ month }) => `Cursor — abonnement IA ${month}`,
  invoice: "cursor",              // optional: which adapter fetches the PDF
}
```

Then `bun run rules:check`. There are two nets under you:

- the **shape** of the file is validated on load, so `suplier:` or `invoice: "gcpp"` fails
  immediately instead of quietly matching everything;
- every **label** is resolved against the live schema, so a typo fails loudly with the
  valid alternatives instead of writing the wrong thing:

```
✗ rule "Cursor": field "Catégorie de dépense" has no value "Trainings" — valid:
  Directors, Finance, IT Costs, Management Fees, ..., Training
```

Matching is first-rule-wins, top to bottom. **Anything unmatched is escalated, never
guessed** — a wrong field is silently wrong in Theodo's accounts, an escalation costs one
email.

Rules that need a human use `ask` instead of `fields`: one free-text reply supplies both
the category and the description, which is the only way to handle meals (`dej networking`
is Sales, `dej avec Regis medina radical academy` is Training — not inferable from the
transaction).

## Adding a vendor

Drop a module in `src/vendors/` exporting `loggedOut(page)`, `list(page)` and
`download(context, page, entry)`, and register it in `src/vendors/index.ts`. A new
Stripe-billed vendor is mostly a copy of `cursor.ts`.

Verification is shared and not optional: every PDF is read back with `pdftotext` (through
`Bun.$`) and must state the amount Spendesk charged, or it is deleted and the payable is
escalated.

## Why Playwright, not Bun.WebView

Bun 1.4 ships `Bun.WebView`, and it was tried. It cannot replace Playwright here:

- `new Bun.WebView({ headless: false })` throws *"headless: false is not yet
  implemented"* — there is no visible window, so it cannot host the re-auth explainer;
- the sessions live in `.browser-data/`, a **Chrome** persistent profile launched with
  `channel: "chrome"` and `chromiumSandbox: true`, because macOS will not hand a passkey
  request to Playwright's bundled Chrome for Testing (DESIGN §11). WebView's `dataStore`
  is a different store.

## Setup

```bash
bun install
bunx playwright install chrome
brew install poppler           # pdftotext
```

`.spendesk-api` holds the public-API credentials, two lines:

```
ID=...
Secret=...
```

Then `bun run reauth` once to sign in, and `bun run schedule` to run it daily at 08:00
(launchd). `bun run schedule:bun` registers the same job through `Bun.cron` instead — also
launchd underneath, but it logs to `/tmp/bun.cron.spendesk-daily.*.log` rather than
`logs/`, which is why the explicit plist is the default.

## What it needs from you

- **Re-authentication.** Assume every couple of weeks, until a month of run logs shows the
  real cadence. Touch ID, then approve on the Spendesk phone app — PSD2, not scriptable.
- **Answering the digest.** About 4 emails a month, never more than one a day.

## Safety

The Spendesk API credential is company-wide and `PATCH` replaces line items wholesale, so
it could in principle reach someone else's €50k invoice. The guards in
`src/spendesk/write.ts` prevent that — the payable must be yours, must still be
`toPrepare`, must not be exported, must carry a version, every line item must have a gross
amount, the amounts must still add up, and the tax account is preserved verbatim. They are
covered by `bun test`, and `dry` is a *required* argument on every function that writes, so
no call site can forget to thread `--dry` through.

Everything runs locally with your own credentials. Session cookies stay in
`.browser-data/` on your Mac; this is deliberately not a hosted service.
