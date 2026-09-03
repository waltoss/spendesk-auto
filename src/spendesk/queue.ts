// Spendesk is the work queue: what has been charged to my card and is not yet complete.
//
// There are two vantage points, and which one we use decides the whole SLA.
//
//   payment  the transaction itself. Exists from day 0. Every write we need — description,
//            receipt, custom fields — works here, through the app's own API. Spendesk's
//            control-rules oracle says exactly what is missing.
//   payable  the accounting document. Spendesk creates it two days after the transaction,
//            which is two thirds of the three-day fuse gone before anything can be done.
//            Reachable with the public API alone, so it survives a dead session.
//
// Payments are therefore the primary source and payables the fallback. That is not a
// preference: it is the difference between a 72-hour window and a 24-hour one.
import type { BrowserContext } from "playwright";
import type { Need, PayableItem, PaymentItem } from "../types.ts";
import {
  AttachmentsResponse,
  Completion,
  FetchPaymentsResponse,
  parsed,
  Payable,
  SearchResponse,
  type PaymentNode,
} from "../schemas/spendesk.ts";
import { APP, COMPANY_ID, GRAPHQL, internalApiAs, publicApi, publicApiAs } from "./auth.ts";
import type { LiveSchema } from "./schema.ts";

/** The card is blocked ~3 days after the transaction (DESIGN §1). */
const FUSE_HOURS = 72;

const major = (minor: number | null | undefined): number => (minor ?? 0) / 100;
const hoursLeftFrom = (date: string): number => FUSE_HOURS - (Date.now() - new Date(date).getTime()) / 36e5;

// --------------------------------------------------------------- payments (primary)

const FETCH_PAYMENTS = `query FetchPayments($companyId: String!, $first: Int, $filtersV1: [PaymentsFilters], $filtersV2: [JSON]) {
  company(id: $companyId) {
    payments(orderBy: PAID_DATE_NULL_THEN_DESC, first: $first, filters: $filtersV1, filters_v2: $filtersV2) {
      edges { node {
        databaseId description completionState state
        amount_declared currency_declared paid_at created_at card_id
        invoices { total } invoice_lost invoice_invalid
        supplier { name } costCenter { name }
      } }
    }
  }
}`;

/**
 * When the card was actually used.
 *
 * The ~3-day fuse starts at the card *authorisation*, not at settlement: `created_at`
 * matches the "New purchase of ..." email to the second, while `paid_at` is the later
 * clearance — around 12h later, and sometimes a full day. Measuring from `paid_at` would
 * therefore report more time remaining than there is, which is the one direction that
 * cannot be allowed to be wrong. It is also null while a payment is still `authorised`,
 * which is exactly when the deadline is closest.
 */
const authorisedAt = (n: PaymentNode): string | null => n.created_at ?? n.paid_at ?? null;

/** One GraphQL round trip, parsed. Both callers filter by payer — the token is company-wide. */
export async function fetchPayments(
  context: BrowserContext,
  { memberId, first = 60, query = FETCH_PAYMENTS }: { memberId: string; first?: number; query?: string },
): Promise<PaymentNode[]> {
  const res = await context.request.post(GRAPHQL, {
    headers: { origin: APP, referer: `${APP}/` },
    data: {
      operationName: "FetchPayments",
      variables: { companyId: COMPANY_ID, first, filtersV1: [], filtersV2: [{ type: "payer", value: [memberId] }] },
      query,
    },
    timeout: 25_000,
  });
  if (!res.ok()) throw new Error(`GraphQL FetchPayments → HTTP ${res.status()}`);
  const body = parsed(FetchPaymentsResponse, await res.json(), "GraphQL FetchPayments");
  if (body.errors?.length) throw new Error(`GraphQL FetchPayments: ${JSON.stringify(body.errors).slice(0, 200)}`);
  return (body.data?.company?.payments?.edges ?? []).map((e) => e.node);
}

/**
 * Everything of mine that Spendesk considers incomplete, with the exact reasons.
 * Needs a browser session: the GraphQL and the oracle are both the app's own API.
 */
export async function listIncompletePayments({
  context,
  memberId,
  schema,
  first = 60,
  windowDays = 10,
}: {
  context: BrowserContext;
  memberId: string;
  schema: LiveSchema;
  first?: number;
  windowDays?: number;
}): Promise<PaymentItem[]> {
  const nodes = await fetchPayments(context, { memberId, first });
  const out: PaymentItem[] = [];

  // The list carries its own completionState, but it is not the authority and has been
  // seen to disagree with the control rules (DESIGN §8.5). The dangerous direction is it
  // saying "complete" when the rules would not — that silently skips a payment and the
  // card blocks. So inside the fuse window every payment is put to the oracle regardless,
  // and the cheap field is only trusted for older ones that are past saving anyway.
  const cutoff = Date.now() - windowDays * 864e5;
  const actionable = nodes.filter(
    (n) => new Date(authorisedAt(n) ?? 0).getTime() >= cutoff || n.completionState !== "complete",
  );

  for (const node of actionable) {
    const detail = await internalApiAs(
      Completion,
      context,
      "GET",
      `/control-rules/completions/by-payment/${node.databaseId}`,
    );
    const missing = detail.incompleteData;

    const needs: Need[] = [];
    for (const fieldId of missing?.missingCustomFields ?? [])
      needs.push({ kind: "field", fieldId, label: schema.labelFor(fieldId) });
    if (missing?.isDescriptionMissing) needs.push({ kind: "description" });
    if (missing?.isReceiptMissing) needs.push({ kind: "receipt" });
    if (missing?.isCostCenterMissing) needs.push({ kind: "costCenter" });
    if (missing?.isSupplierMissing) needs.push({ kind: "supplier" });

    out.push({
      kind: "payment",
      paymentId: node.databaseId,
      supplier: node.supplier?.name ?? null,
      description: node.description ?? "",
      // native, already in major units here — and a string ("406.98") on the wire
      amount: Number(node.amount_declared),
      currency: node.currency_declared ?? "",
      cardId: node.card_id ?? null,
      paidAt: (authorisedAt(node) ?? "").slice(0, 10),
      hoursRemaining: authorisedAt(node) ? hoursLeftFrom(authorisedAt(node)!) : null,
      hasReceipt: (node.invoices?.total ?? 0) > 0,
      fields: {},
      needs,
      completionState: detail.state ?? "incomplete",
    });
  }
  return out.sort((a, b) => (a.hoursRemaining ?? 0) - (b.hoursRemaining ?? 0));
}

// -------------------------------------------------------------- payables (fallback)

/**
 * The public-API view. Slower to appear and it can only approximate what is required —
 * the oracle knows the answer varies per payment, this does not — but it needs no session,
 * so a dead login still gets fields and receipts written.
 */
export async function listIncompletePayables({
  memberId,
  requiredFields = [],
}: {
  memberId: string;
  requiredFields?: string[];
}): Promise<PayableItem[]> {
  const { payables } = await publicApiAs(SearchResponse, "/v1/payables/search", {
    method: "POST",
    body: {
      limit: 100,
      sort: "desc",
      filters: {
        operator: "and",
        subfilters: [
          // The credential is company-wide: without this, search returns every Theodo FR
          // payable, including €50k subcontracting invoices (DESIGN §8.6).
          { field: "requestor", operator: "=", value: [memberId] },
          { field: "bookkeepingStatus", operator: "=", value: ["toPrepare"] },
        ],
      },
    },
  });

  const out: PayableItem[] = [];
  for (const found of payables) {
    if (found.memberId !== memberId) continue; // belt and braces on a company-wide token

    const [detail, attachments] = await Promise.all([
      publicApiAs(Payable, `/v1/payables/${found.id}`),
      publicApiAs(AttachmentsResponse, `/v1/payables/${found.id}/attachments`).catch(() => ({ data: [] })),
    ]);

    const fields: Record<string, string> = {};
    for (const a of detail.analyticalProperties) fields[(a.fieldName ?? "").trim()] = a.valueName ?? "";
    const has = (label: string): boolean =>
      Object.keys(fields).some((k) => k === label.trim() || k.startsWith(label.trim()));

    const needs: Need[] = [];
    for (const label of requiredFields) if (!has(label)) needs.push({ kind: "field", label });
    if (!(detail.description ?? "").trim()) needs.push({ kind: "description" });
    if (!attachments.data.length) needs.push({ kind: "receipt" });

    const paidAt = detail.payableDate ?? (found.creationDate ?? "").slice(0, 10);

    out.push({
      kind: "payable",
      payableId: detail.id,
      supplier: detail.counterparty?.name ?? null,
      description: detail.description ?? "",
      amount: major(detail.amount), // native (USD 20.00), never functionalAmount
      currency: detail.currency ?? "",
      paidAt,
      cardId: null, // the public payable view does not expose the card
      hoursRemaining: hoursLeftFrom(`${paidAt}T00:00:00Z`),
      hasReceipt: attachments.data.length > 0,
      fields,
      needs,
      completionState: needs.length ? "incomplete" : "complete",
      // Kept apart deliberately: search says toPrepare|toExport|exported, GET says
      // created|... Different vocabularies, never to be compared (§8.6).
      searchState: found.state ?? null,
      version: detail.version ?? null,
    });
  }
  return out.sort((a, b) => (a.hoursRemaining ?? 0) - (b.hoursRemaining ?? 0));
}

/**
 * Amounts of every payable of the member in the recent past, complete or not.
 *
 * Used only to answer "has Spendesk minted anything for this purchase email yet?". The
 * incomplete queue cannot answer that: a purchase whose payable exists and is already
 * complete is indistinguishable there from one Spendesk has not created at all, and only
 * the second is a reason to log in.
 */
export async function recentPayableAmounts({ memberId }: { memberId: string }): Promise<{ amount: number; currency: string }[]> {
  const { payables } = await publicApiAs(SearchResponse, "/v1/payables/search", {
    method: "POST",
    body: {
      limit: 100,
      sort: "desc",
      filters: {
        operator: "and",
        subfilters: [{ field: "requestor", operator: "=", value: [memberId] }],
      },
    },
  });
  const out: { amount: number; currency: string }[] = [];
  for (const found of payables) {
    if (found.memberId !== memberId) continue;
    const detail = await publicApiAs(Payable, `/v1/payables/${found.id}`);
    out.push({ amount: major(detail.amount), currency: detail.currency ?? "" });
  }
  return out;
}

/** Which payables does Spendesk say this paymentId produced? Used to confirm a join. */
export async function payablesForPayment(paymentId: string): Promise<string[]> {
  const { payables } = await publicApiAs(SearchResponse, "/v1/payables/search", {
    method: "POST",
    body: {
      limit: 5,
      filters: { operator: "and", subfilters: [{ field: "paymentId", operator: "=", value: [paymentId] }] },
    },
  });
  return payables.map((p) => p.id);
}

/** Re-exported so verify.ts and write.ts can read a payable without importing auth. */
export const getPayable = (payableId: string): Promise<Payable> =>
  publicApiAs(Payable, `/v1/payables/${payableId}`);

export const getAttachmentCount = async (payableId: string): Promise<number> => {
  const raw = await publicApi(`/v1/payables/${payableId}/attachments`).catch(() => ({ data: [] }));
  return parsed(AttachmentsResponse, raw, `GET /v1/payables/${payableId}/attachments`).data.length;
};
