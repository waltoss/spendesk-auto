# Spendesk expense automation — design & implementation spec

> **Superseded in part.** The session-lifetime and payable-timing figures below were
> re-measured on 2026-09-02 and were wrong. See [REDESIGN.md](REDESIGN.md) §2 for the
> corrected numbers and §3 for the proposed change to how logins are triggered.

Status: **rebuilt** (2026-09-02). All five steps of §15 are built. GCP retrieval is proven end to
end; `run` without `--dry` and the Cursor adapter have not yet been exercised since the rebuild.
Everything below is either measured against the live account or explicitly flagged as unknown.

---

# Part I — Why

## 1. It is an SLA problem, not data entry

A card transaction gets a ~3-day fuse. Miss it and the card is declined, usually discovered at a
restaurant rather than at a desk.

```
day 0   transaction happens
day 2   payable appears in Spendesk   (firstCreatedAt == payableDate + 2d, ~03:45 UTC batch)
day 3   card blocked
```

**The actionable window is ~24 hours.** Nothing exists to act on before day 2. Therefore:

- the job runs **daily**, not monthly;
- mechanical cases are filled **autonomously** — a confirm step reintroduces the latency that
  causes the block;
- every step **verifies its own output**, because one silent failure is a blocked card.

## 2. Measured volumes

Last 60 payments, 2026-04-09 → 2026-08-19 (131 days):

| | count | per month |
|---|---|---|
| payments | 60 | 13.9 (3.2/week) |
| automatable SaaS | 27 | 6.3 |
| needs a human (meals, taxis, hotels) | 25 | 5.8 |
| missing a receipt | 3 | 0.7 |

Escalations batched into one digest per day, sent only when needed: 16 of 131 days had anything to
ask → **~3.7 emails/month**. Never more than one a day; most days none.

Retrieval is **5% of the problem**. Fields and description are the workload.

---

# Part II — What to build

## 2b. Payments, not payables — the SLA fix (2026-09-02)

Every write we need works on the **payment**, which exists from day 0:

| | endpoint | notes |
|---|---|---|
| description | `PUT /api/{co}/payments/{id}` `{id, description}` | verified: only version, updated_at, description change |
| receipt | `POST /api/{co}/invoices/{id}` multipart, field **`invoices`** | `POST /payments/{id}/invoices` is a different, account-owner-only route (403) |
| custom fields | `PUT /api/{co}/payments/{id}` `{id, costCenterId, custom_fields_associations:[{customFieldId, customFieldValueId, value}]}` | full replacement; `costCenterId` rides along and is wiped if omitted |

**Trap:** `custom_fields` and `customFields` are both accepted and **silently ignored**, returning
200. Only `custom_fields_associations` works. A 200 that does nothing is worse than a 403 — verify
by re-reading, never by status code.

The public API needs a `payableId`, which Spendesk only mints two days after the transaction. The
payment path therefore turns a ~24h actionable window into ~72h. Payables remain the fallback for a
dead session, since fields and receipts there need no cookie.

`GET /control-rules/completions/by-payment/{id}` returns the exact reasons, and required fields
**vary per payment** — one GCP charge needed none, another needed two. Any offline approximation
over-reports, so the oracle drives the work and confirms it afterwards.

## 3. Architecture

Pull, not push: Spendesk is the work queue, vendors are fetched on demand. The original `src/`
pushed — scraped Cursor monthly and mailed the PDF — which is why it re-downloaded the same
invoice twelve times and could not tell success from failure.

```
       ┌─ spendesk/queue ──────────── list my incomplete payments
       │
       ├─ rules ───────────────────── match supplier → fields + description, or "ask"
       │
       ├─ vendors/* ───────────────── fetch + verify the invoice PDF   (only if missing)
       │
       ├─ spendesk/write ──────────── PATCH fields · PUT description · POST attachment
       │
       ├─ spendesk/verify ─────────── completionState must be "complete"
       │
       └─ notify ──────────────────── one digest email for whatever is left
```

## 4. Repo layout

Delete `src/` entirely — it is the push design and none of it survives. Keep `prototypes/` as
reference until the rebuild passes, then delete all but the recon scripts worth keeping.

Bun 1.4 + TypeScript (strict), zod at every API boundary. Playwright stays: `channel:"chrome"`
is required for macOS passkeys and Bun's `WebView` cannot do `headless: false`.

```
config/rules.ts         the only file to edit for a new supplier or rule
src/
  index.ts              CLI: run | fetch | check | reauth | rules:check | schedule
  run.ts                the daily job
  rules.ts              the matcher — the only interpreter of config/rules.ts
  types.ts              QueueItem / Need / Decision / Result unions
  schemas/
    spendesk.ts         zod for every public, internal and GraphQL response
    rules.ts            zod for the rules file (strictObject: a typo'd key fails)
  spendesk/
    auth.ts             public-API token; session cookie liveness
    queue.ts            payments (primary) + payables (fallback)
    write.ts            buildPatch (the guards, pure) + payment/payable writes
    verify.ts           re-read after writing; the completions oracle
    schema.ts           label ↔ id both ways; validate the rules file
  vendors/{index,cursor,gcp}.ts
  browser.ts  reauth.ts  notify.ts  log.ts  schedule.ts  job.ts  config.ts
test/
  guards.test.ts        the write invariants, against real payable fixtures
  rules.test.ts         matching, especially what must NOT match
  verify.test.ts        golden PDFs: the readable one passes, the blank one fails
```

## 5. Module contracts

```js
// spendesk/queue.mjs
listIncomplete({ memberId, requiredFields }) → [{
  payableId,            // public API uuid — needed by PATCH
  supplier, description,
  amount, currency,     // NATIVE (USD 20.00), never functionalAmount
  paidAt, hoursRemaining,
  hasReceipt, fields: { [fieldName]: valueName },
  needs,                // [{kind:"field",label} | {kind:"description"} | {kind:"receipt"}]
  completionState,      // "complete" | "incomplete"
  searchState, version, // kept apart: search and GET use different status vocabularies
}]

// rules.mjs
match(payment) → { kind: "auto", fields, description }
               | { kind: "ask", question, derive }
               | { kind: "unknown" }

// vendors/index.mjs
fetchInvoice({ vendor, amount, currency, date }) → { file, verified: true }
                                                 | { error }   // never a guess

// spendesk/write.mjs
setFields(payableId, fields)        // 5 guards, see §9
setDescription(paymentId, text)
attachReceipt(payableId, file)
```

## 6. Run modes

```
node src/index.mjs run          # the daily job (launchd, 08:00)
node src/index.mjs run --dry    # decide everything, write nothing — prints the plan
node src/index.mjs check        # session + rules validity, exit 1 if broken
node src/index.mjs reauth       # explainer → login → success
node src/index.mjs rules:check  # resolve every label against the live schema

node src/index.mjs fetch gcp --amount 266.49   # exercise one vendor adapter alone
```

`--dry` is the development and debugging mode. The scheduled job runs without it, by design (§1).

## 7. Configuration — `config/rules.mjs`

Written in the labels shown in Spendesk, never in ids. Resolved against the live schema at startup,
so a typo or a renamed dropdown fails loudly before anything is written.

```js
{
  name: "Cursor",
  when: { supplier: /^cursor$/i },
  fields: { "Catégorie de dépense": "IT Costs" },
  description: ({ month }) => `Cursor — abonnement IA ${month}`,
  invoice: "cursor",                       // optional: which vendor adapter fetches the PDF
}
```

First-rule-wins, top to bottom. Unmatched → escalate, never guess.

`npm run rules:check` proves it. With a deliberate typo it fails usefully:

```
✗ field "Catégorie de dépense" has no value "Trainings" — valid: Directors, Finance,
  IT Costs, Management Fees, Marketing, Office, People, Project, Recruitments, Sales,
  Staffing, Training
```

`memberId` is resolved from an email via `/v1/users` (paginate — Theodo has >30 users), so no ids
are hardcoded anywhere.

---

# Part III — Reference

## 8. Spendesk

Two APIs. The **public API** (documented, client credentials) does the queue, required fields and
attachments. The **internal app API** (session cookie, undocumented) does the description and the
completeness oracle, because the public API cannot.

### 8.1 Queue — public API only ✅ corrected during the rebuild

This was specced around the app's GraphQL because `/v1/payables/search` returns no supplier
name, only `counterparty.supplierId` — and `/v1/suppliers` is 403 under our scopes. But
**`GET /v1/payables/{id}` returns `counterparty.name`**, plus the description, the resolved
field labels (`analyticalProperties` carries `fieldName`/`valueName`, no id lookup needed),
the `version` and `exportedAt`. `GET /v1/payables/{id}/attachments` answers "is there a
receipt".

So the queue is: search for my `toPrepare` ids, then one GET per payable. No browser
session, which means a dead session degrades the run — fields and receipts still get
written, only descriptions are deferred — instead of stopping it. That is a materially
better failure mode than the original design, given the session dies fortnightly.

The GraphQL below is still needed for one thing: the `paymentId` that the description PUT
requires, which the public API never exposes.

```graphql
query FetchPayments($companyId: String!, $first: Int, $after: String,
                    $filtersV1: [PaymentsFilters], $filtersV2: [JSON]) {
  company(id: $companyId) {
    payments(orderBy: PAID_DATE_NULL_THEN_DESC, first: $first, after: $after,
             filters: $filtersV1, filters_v2: $filtersV2) {
      pageInfo { hasNextPage endCursor }
      edges { node {
        databaseId completionState description
        invoices { total } invoice_lost invoice_invalid
        amount_declared currency_declared amount_billed fx_fee_amount
        paid_at created_at state
        supplier { name } costCenter { name } user { _id full_name }
        transaction { clean_description }
      } }
    }
  }
}
```

`variables: {companyId, first: 60, filtersV1: [], filtersV2: [{type:"payer", value:["<memberId>"]}]}`

`databaseId` is the payment id used by the description `PUT`, **and** the public API accepts it as a
`paymentId` filter — that is the bridge between the two APIs.

Matching a payable to its payment on amount + currency + date is not safe on its own, so
`resolvePaymentId` confirms every candidate by asking the public API which payable that
`paymentId` belongs to. No confirmation, no description write.

### 8.2 Fields — `PATCH /v1/payables/{id}` ✅ verified

Clearing the three custom fields removed the requester-side *"Please fill the following mandatory
fields"* warning in the UI: the accounting layer and the requester form are the same view. Body
needs `version` plus a **complete** `lineItems` replacement (all five of `grossAmount`,
`expenseAccountId`, `taxAccountId`, `costCenterId`, `analyticalFieldValues`).

Exactly three fields are required, from `GET /api/{companyId}/custom-fields` (`is_required`,
`eligible_types` — the public API exposes neither). The "matricule" field is eligible only for
subscriptions and requests, so **no conditional branch exists**.

### 8.3 Description — internal only

Not writable via the public API: `PATCH` rejects it with `400 must NOT have additional properties`,
and none of the 51 write endpoints accept one.

```
PUT https://api.spendesk.com/api/{companyId}/payments/{paymentId}
{"description": "…", "id": "{paymentId}"}
```

Auth is the session cookie; `context.request.put()` sends it. No DOM selectors.

### 8.4 Attach — `POST /v1/payables/{id}/attachments`

Send `{mimeType, contentLength}`, receive `{method, url, fields}`, POST the file there. Card
payables only. Preferred over `invoices@theodo.fr`, which works but matches by OCR.

### 8.5 Verify — query, never model

```
GET  /api/{companyId}/control-rules/completions/by-payment/{paymentId} → {"state":"complete"}
POST /v1/payables/search → documentaryEvidence.validity → {"valid": false, "reason": …}
```

Two €180 claude payments — both description-less, both with receipts — disagree on
`completionState`, so the rule has a wrinkle we cannot see. Find `incomplete`, fill everything
derivable, re-query, assert `complete`.

### 8.6 Traps

- Search filters take **major** units (`17.9`); responses return **minor** units (`1790`).
- `amount`/`currency` is native (USD 20.00); `functionalAmount` is EUR. Match on native — EUR moves
  with FX and conversion fees.
- `expenseAccountId` is null on `toPrepare`, set on `exported`: accounting assigns it at export. It
  is **not** the requester-facing "expense category".
- Search returns `state: toPrepare|toExport|exported`; GET returns `bookkeepingStatus: created|…`.
  Never compare them.
- The tenant is company-wide — search returns every Theodo FR payable, including €50k
  subcontracting invoices. **Always** filter by `requestor`.
- `GET /v1/analytical-fields/{id}/values` caps `pageSize` at 30; the label key is `value`, not `name`.

## 9. Safety invariants

`PATCH lineItems` is a full replacement and the credential is company-wide, so the blast radius is
contained in code. Seven guards (the original five plus "must carry a version" and "every line item
must have a gross amount", both previously `undefined`-tolerant):

1. `payable.memberId === MY_MEMBER_ID` or throw
2. `payable.state === 'toPrepare'` or throw — never touch `exported`
3. read-modify-write with `version`; change **only** `analyticalFieldValues`
4. assert `sum(lineItems.grossAmount) === payable.amount` before sending
5. preserve `taxAccountId` verbatim — null ≠ tax-exempt

Both write paths are proven: filling a blank payable (Cursor $20, fields 0 → 3) and correcting an
existing one (GCP €309.58, `IT Costs` → `Training`), the latter round-tripping a payable the code
had never seen while leaving amount, VAT, cost center and description untouched.

## 10. Vendors

Adapter shape — a new Stripe-billed vendor is mostly a copy of `cursor.mjs`:

```js
{ url, loggedOut, async list(page), async download(context, page, entry), verify? }
```

Shared by the registry: login detection by identity-provider redirect, amount-targeted matching,
`pdftotext` verification, deletion of any PDF that is unreadable or whose amount disagrees.

### Cursor ✅ solved

Headless, no interaction. The dashboard row gives `date / amount / currency / status`; the Stripe
hosted page is a 745-byte JS shim, so the PDF requires rendering and clicking **"Download
invoice"** — not "Download receipt", which is the wrong document and explains the stray
`Receipt-*.pdf` files.

### GCP — via payments.google.com, never the Cloud Console

```
/gp/w/u/0/home/subscriptionsandservices        → one card per billing account
  "Gérer"  (a <button> with a jsaction; URL minted on click, there is no href)
  → /gp/w/u/0/home/accountdetail?ebaid=<encrypted billing account id>
     → renders in a payments/u/0/embedded_landing_page iframe
        → "Afficher les transactions et les documents"
           → payments/u/0/timelineview iframe:
               .b3id-collapsing-card              one per period
                 .b3-card-header-subtitle         "Solde de clôture : 406,98 €"
                 .b3id-document-zippy-group       "Facture PDF" and "Relevé"
```

**Solved 2026-09-02**, end to end, headless, on both Radical Academy invoices.

Two traps cost the earlier attempts:

1. **The facture row is not a link.** The Relevé carries `data-download-url` directly, but the
   facture is a `div[role=button].jfk-freestanding-menu-button` with `aria-haspopup="true"` and no
   href and no `jsaction` attribute. Clicking it opens a `.goog-menu-vertical` whose
   *"Téléchargement"* item holds the `data-download-url`; the click on the row itself only fires
   Google's impression logging. So: click the row, read the URL out of the menu, and fetch it with
   `context.request.get()` — which carries the session cookies and avoids racing a download event.

   ```
   /payments/apis-secure/doc/u/0/trs?doc=<token>&req=<token>
   ```

2. **Only the newest period card is expanded.** Reading `innerText` therefore finds only the latest
   invoice — July's facture was in the DOM but invisible, which is why matching it "worked" for
   August and failed for July. Selection now walks the DOM (`.b3id-collapsing-card` →
   `.b3-card-header-subtitle` closing balance → the `Facture PDF` group), which reads collapsed
   cards, and the card is expanded before the row is clicked.

Selecting the document out of the `Facture PDF` group by name also makes "never the Relevé" a
structural property rather than a lucky regex.

Charges are not strictly monthly: each account has a payment threshold (500 € / 100 €) that triggers
off-cycle charges. Drive retrieval from "Spendesk has a GCP payable with no receipt", never a calendar.

**Dead ends — do not retry:** the Payments *document center* returns `Aucun document` for every
profile and view (it lists payments-profile documents, which is what *invoiced* billing produces;
these accounts are self-serve so statements hang off the billing account — same root cause as "no
invoice emails"). `POST /payments/apis-secure/doc/u/0/get_document_archive` gives 405 on GET and 500
on every body shape. The Cloud Console works but is ~400 requests and 3MB of Angular, and automating
it produced *"Google has temporarily blocked your account or network due to excessive automated
requests"* on a work account.

### Verification is vendor-agnostic

`pdftotext`, then assert the expected amount appears. Not theoretical: 14 of the 25 files in
`invoices/` are ~2.9KB `tryPrintPageAsPdf()` output with **zero extractable text** — a page that
never rendered, saved and reported as success. That fallback does not survive the rebuild.

## 11. Auth — corrected

| surface | auth | measured |
|---|---|---|
| Spendesk public API | client credentials | ≤1 year; diarise the expiry |
| Spendesk internal | `SPX_*` cookies | **died after 14 idle days** |
| Google (GCP) | OAuth in the browser profile | months |
| Cursor | own `cursor.com` cookie | months |

**Cookie expiry is not session lifetime, and the real number is 60 minutes.** Measured
2026-09-02 by decoding the JWTs in the cookie jar:

```
SPX_ACCESS_TOKEN    ttl =  60 min     cookie expiry 1 year
SPX_REFRESH_TOKEN   ttl = 600 min     cookie expiry 1 year
```

Both cookies persist for a year, which is why every earlier estimate (4x/year, then
fortnightly, then "2.4 hours, probably load-related") was wrong. The session dies exactly
one hour after login.

`sessionAlive`'s "load the SPA and retry" does not help: with an expired access token the
app calls `/api/user`, takes the 401 and redirects to `/auth/login`. It refreshes on a
**timer while open**, which a once-a-day job can never hit. So that retry path is, in
practice, dead code.

**Consequence:** every scheduled run finds an expired token and falls back to payables.
Fields and receipts still get written through the public API, but descriptions do not, and
the day-0 window of §2b is lost. Verified by triggering the launchd job: it exited 0,
logged correctly, and reported `no Spendesk session — falling back to payables`.

**Open: the refresh endpoint.** The SPA must call something to trade the 600-minute refresh
token for a new access token, and calling it on a schedule (every ~8h) would keep the
session alive — indefinitely, if the refresh is rolling. Not yet found. Nine plausible
paths under `/api/*` all return a generic `401` from the auth middleware, indistinguishable
from "exists but needs a valid token"; `/auth/*` variants 404; and the app bundle
(`entries/app.<hash>.js`, 592 lazy chunks) yields no endpoint by grep. The reliable route is
the one that cracked the receipt upload and the custom fields: sign in, keep the app open
~55 minutes, and capture the call when the timer fires.

**The tokens are IP-bound** — `ip` and `refreshTokenIp` claims. Changing network or VPN
kills the session regardless of TTL.

This raises the value of the daily check: it converts "blocked card at a restaurant" into "one
30-second chore at breakfast, at worst fortnightly".

Re-auth is two steps: Google passkey (Touch ID), then **Spendesk SCA approved on the phone app**.
The second is PSD2 and not scriptable, so re-auth needs the user at their Mac *with their phone*.

Launch settings, both required:

```js
chromium.launchPersistentContext(PROFILE, {
  channel: "chrome",       // NOT bundled Chromium — see below
  chromiumSandbox: true,   // else --no-sandbox, and Chrome warns about it
  headless: false,
  ignoreDefaultArgs: ["--disable-extensions", "--enable-automation"],
})
```

`channel: "chrome"` is required for passkeys: SSO ends at
`accounts.google.com/v3/signin/challenge/pk`, and macOS will not hand a passkey request to
Playwright's *Chrome for Testing* — it degrades to a "scan this QR code" dialog. Real Chrome gets
the system credential provider and Touch ID appears.

`reauth.mjs` never opens onto a bare login page: an explainer states why the window appeared, how
many expenses are waiting and hours until the card blocks (queried live), then one button, then a
success page, then it closes itself.

## 12. Escalation

One digest per day, only when something needs a decision (~3.7/month).

Meals get a single question — *"who was this meal with, and why?"* — because one free-text reply
yields both the catégorie and the description. Each item states what it is, what is missing, **hours
remaining**, a direct link, and the one action to take.

The reply-parsing regexes in `config/rules.mjs` are **untested** — they need real replies to tune.
Until then, treat a reply as a suggestion to confirm rather than as authoritative.

## 13. Rules, from actual history

`budget confort = Non` on 100% of payments.

| payable | confort | refac | catégorie |
|---|---|---|---|
| Cursor $20 · ElevenLabs $22 · Anthropic/claude €180 · openai | Non | Non | IT Costs |
| GCP — "Budget IA / Cost of Hosting" | Non | Non | IT Costs |
| GCP — "Radical Academy" | Non | Non | Training |
| meals, taxis, hotels | Non | varies | **escalate** |

Meals are the largest single group (`RESTAURANTS DIVERS` alone is 12 of 60) and are not inferable:
`dej networking` → Sales, `dej equipe softway` → Project, `dej avec Regis medina radical academy` →
Training, `gouter` → People, `MANKO PARIS partner day` → Directors.

Refacturation is not always Non — Oui five times, all Softway Medical offsite. `4ol4frdin85g4z`
(client + projet) stayed empty even then; the UI marks it Optional despite "Obligatoire" in its label.

Supplier names are unreliable (`FOURNISSEURS DIVERS`, `N/A`), which is why the ElevenLabs rule also
matches on amount and currency. This is a real fragility, not a solved problem.

They also carry accents: the first live `--dry` escalated `Hôtel Negrecoste` as unmatched
because the rule said `/hotel/`. Patterns are now tried against both the raw name and its
de-accented form, so a rule written either way matches either spelling.

---

# Part IV — Getting there

## 14. Testing

- **`rules:check`** — every label resolves against the live schema. Runs first in the daily job and
  in CI.
- **`run --dry`** against the live queue — the plan must be stable across runs and must never
  include a payable that is not `toPrepare` or not mine.
- **Guard unit tests** — §9 invariants, especially the gross-sum assertion and the memberId check,
  with fixtures taken from real payables.
- **Golden PDFs** — `Invoice-1ED481F4-0021.pdf` (real, 310KB, readable) and
  `cursor-invoice-1786781464529.pdf` (2986 bytes, zero extractable text) as fixtures: the verifier
  must accept the first and reject the second.

Built: 24 tests, `npm test`. The fixtures are real invoices and are therefore gitignored —
the golden tests skip with a message when absent, the rest always run. Payable fixtures in
`test/fixtures/payables.mjs` are copied verbatim from real `GET /v1/payables/{id}`
responses; inventing shapes there would test the test rather than the code.

## 15. Build order

Steps 1, 2, 3 and 5 are done; step 4 is written but never successfully executed.

1. ✅ **`spendesk/` + `rules` + `--dry`** — read the queue, decide everything, write nothing. Highest
   information per line of code; makes the rest reviewable.
2. ✅ **Writes** behind the §9 guards, then `verify` asserting `completionState`. This is ~95% of the
   SLA risk.
3. ✅ **Digest email.** Meals are ~25% of volume and one question unlocks them.
4. ✅ **`vendors/cursor`**, then **`vendors/gcp`**. 5% of the problem and the only place a failure
   can be silent. A `fetch` command exercises an adapter without waiting for a matching payable.
   GCP is proven end to end on both Radical Academy invoices; **Cursor's adapter has not been
   re-run since the rebuild** — it is a faithful port of the working prototype, but that is not
   the same as tested.
5. ✅ **launchd at 08:00** (`launchd/com.theodo.spendesk.plist`). The old monthly
   `com.theodo.cursor-billing` job is unloaded and its plist deleted. Load the new one with
   `bun run schedule`.

## 16. Deliverable

A Claude Code skill plus a recipe, run locally with personal credentials. Not a hosted service —
that would centralise session cookies and an accounting-write key for a finance system. Shareable at
Theodo as a repo colleagues clone and point at their own email.

---

## Appendix — ids and scopes

Company `2avcxkezrxmosd`. Member Thomas Walter `9qytin56a08wku` (resolve from email, don't hardcode).

| field id | name | values |
|---|---|---|
| `0ih_9b1mfr0mzs` | 1) Cette dépense concerne-t-elle votre budget confort ? | `i8sb9djid4q-5p` Non · `d_ezxmad36mbs9` Oui |
| `qrabw6on0c4jha` | 2) A refacturer au client ? | `d0jhoywyefbndo` Non · `alvc_le39ljwhs` Oui |
| `piq72409umm1_s` | Catégorie de dépense | 12 values, below |
| `4ol4frdin85g4z` | 2) [REFACTURATION CLIENT] Nom du client + projet | one value (`ratp-dev`), Optional |
| `qzpdtw61ai75ku` | 1) [BUDGET CONFORT] Matricule du bénéficiaire | not eligible for payments |

Catégorie: `if8popz7uf23cr` Directors · `bhkt-4c8gm_0q9` Finance · `j7jxkhebt95798` IT Costs ·
`7up_bd4q6-a1ar` Management Fees · `6mfwefw700ds5p` Marketing · `tloqnjtf1w1nb6` Office ·
`t0_pg4u1te6m3m` People · `xe9q6lxj3puvxq` Project · `ymcy-1qnias1sv` Recruitments ·
`-721m-a4w4l6og` Sales · `n5w2cxa6vb9le5` Staffing · `1x_tgrnnd72m2m` Training

GCP billing accounts: `012512-2A6C67-A63A08` (Radical Academy) · `0161AF-0347D6-59B14E` ·
`01AFB6-D85F09-FCD896`. Payments profiles: Theodo `2315-6256-8775`, Hokla `1714-5081-3977`,
Hokla `2259-1928-7602` — the "Paiement reçu" email's profile id is a real join key.

Scopes (2026-08-19, Manon Boussion): `payable:read`, `payable-attachment:read`,
`experimental:payable-attachment:write`, `experimental:payable-search:read`,
`experimental:accounting:update`, `analytical-field:read`, `user:read`. All `/v2/*` remain 403.
