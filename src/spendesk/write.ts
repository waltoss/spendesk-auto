// Every write to Spendesk goes through here.
//
// PATCH /v1/payables/{id} replaces lineItems wholesale, and the API credential is
// company-wide — it can reach €50k subcontracting invoices belonging to other people.
// The blast radius is therefore contained in code, by the five guards of DESIGN §9. They
// are cheap; a wrong write lands in Theodo's accounts.
//
// Two things the types add over the JavaScript original:
//
//   * `dry` is a required option on every function that can write, so no call site can
//     forget to thread the flag through. `--dry` failing open is the one bug in this file
//     that would not announce itself.
//   * the payable is a parsed `Payable`, not `any`, so "the response did not have the
//     shape we assumed" is caught at the boundary rather than becoming a PATCH body with
//     `undefined` in it.
import { Buffer } from "node:buffer";
import path from "node:path";
import type { BrowserContext } from "playwright";
import type { PayableItem, QueueItem } from "../types.ts";
import {
  AttachmentGrant,
  InternalPayment,
  parsed,
  PatchPayableResponse,
  type Payable,
} from "../schemas/spendesk.ts";
import { APP, COMPANY_ID, INTERNAL_API, internalApi, internalApiAs, publicApi, publicApiAs } from "./auth.ts";
import { fetchPayments, getPayable, payablesForPayment } from "./queue.ts";
import type { LiveSchema } from "./schema.ts";

export class GuardError extends Error {
  override readonly name = "GuardError";
}

/** A field/value pair whose labels have already been resolved against the live schema. */
export interface FieldAssignment {
  fieldId: string;
  valueId: string;
}

export interface PatchLineItem {
  grossAmount: number;
  expenseAccountId: string | null;
  taxAccountId: string | null;
  costCenterId: string | null;
  analyticalFieldValues: FieldAssignment[];
}

export interface PatchBody {
  version: number;
  lineItems: PatchLineItem[];
}

/**
 * The five guards of DESIGN §9, as a pure function so they can be unit-tested against
 * real payables without touching the network. Returns the PATCH body, or throws.
 *
 * @param resolved  [{ fieldId, valueId }] — labels already resolved against the schema
 */
export function buildPatch(
  payable: Payable,
  resolved: readonly FieldAssignment[],
  { memberId, expectedSearchState }: { memberId: string; expectedSearchState?: string | null },
): PatchBody {
  // (1) it must be mine
  if (payable.userId !== memberId)
    throw new GuardError(`payable ${payable.id} belongs to ${payable.userId}, not ${memberId}`);

  // (2) it must still be editable. searchState comes from /payables/search; exportedAt is
  //     an independent check on the GET, because the two endpoints use different
  //     vocabularies for status and must never be compared to each other (§8.6).
  if (expectedSearchState !== "toPrepare")
    throw new GuardError(`payable ${payable.id} is "${expectedSearchState}", refusing to touch anything but toPrepare`);
  if (payable.exportedAt) throw new GuardError(`payable ${payable.id} was exported at ${payable.exportedAt}`);

  // (3) read-modify-write: keep every line item as it is and change only its analytical
  //     values. Existing values for fields we are not setting are preserved.
  //     Without a version there is no optimistic concurrency, and a blind write is exactly
  //     what these guards exist to prevent.
  if (typeof payable.version !== "number")
    throw new GuardError(`payable ${payable.id} has no version — refusing to write blind`);

  const lineItems: PatchLineItem[] = payable.lineItems.map((li) => {
    const grossAmount = li.financial?.grossAmount;
    if (typeof grossAmount !== "number")
      throw new GuardError(`payable ${payable.id} has a line item with no gross amount — refusing to write`);

    const keep = li.analyticalProperties
      .filter((a) => a.fieldId && a.valueId && !resolved.some((r) => r.fieldId === a.fieldId))
      .map((a) => ({ fieldId: a.fieldId as string, valueId: a.valueId as string }));

    return {
      grossAmount,
      expenseAccountId: li.expenseAccount?.id ?? null,
      // (5) preserve the tax account verbatim — null is not the same as tax-exempt
      taxAccountId: li.vatAccount?.id ?? null,
      costCenterId: li.costCenterId ?? payable.costCenterId ?? null,
      analyticalFieldValues: [...keep, ...resolved.map((r) => ({ fieldId: r.fieldId, valueId: r.valueId }))],
    };
  });

  // (4) the amounts must still add up to the payable after our rewrite
  const sum = lineItems.reduce((n, li) => n + li.grossAmount, 0);
  if (sum !== payable.amount)
    throw new GuardError(`line items sum to ${sum} but payable is ${payable.amount} — refusing to write`);

  return { version: payable.version, lineItems };
}

/** Resolve every label, refusing the whole write if any one of them is unknown. */
function resolveAll(schema: LiveSchema, fields: Record<string, string>) {
  return Object.entries(fields).map(([label, value]) => {
    const r = schema.resolveValue(label, value);
    if (!r.ok) throw new GuardError(r.error);
    return r.value;
  });
}

export type SetFieldsResult = { dry: true; body: PatchBody } | { dry: false; version: number | null };

/**
 * Fill the custom fields on a payable.
 * @param fields  { "Catégorie de dépense": "IT Costs", ... } — labels, not ids.
 */
export async function setFields(
  payableId: string,
  fields: Record<string, string>,
  {
    schema,
    memberId,
    expectedSearchState,
    dry,
  }: { schema: LiveSchema; memberId: string; expectedSearchState?: string | null; dry: boolean },
): Promise<SetFieldsResult> {
  const payable = await getPayable(payableId);
  const resolved = resolveAll(schema, fields);

  const body = buildPatch(payable, resolved, { memberId, expectedSearchState });
  if (dry) return { dry: true, body };

  const res = await publicApiAs(PatchPayableResponse, `/v1/payables/${payableId}`, { method: "PATCH", body });
  return { dry: false, version: res?.item?.version ?? null };
}

/**
 * The description is not writable through the public API: PATCH rejects it with
 * "must NOT have additional properties", and none of the 51 write endpoints accept one.
 * The app's own PUT does it, authenticated by the session cookie (DESIGN §8.3).
 */
export async function setDescription(
  context: BrowserContext,
  paymentId: string,
  text: string,
  { dry }: { dry: boolean },
): Promise<void> {
  if (dry) return;
  await internalApi(context, "PUT", `/payments/${paymentId}`, { id: paymentId, description: text });
}

export interface UploadResult {
  uploaded: string;
  bytes: number;
}

/**
 * Attach a receipt: ask for a presigned upload, then post the file there.
 * Card payables only. Preferred over invoices@theodo.fr, which matches by OCR.
 */
export async function attachReceipt(
  payableId: string,
  file: string,
  { dry }: { dry: boolean },
): Promise<UploadResult> {
  const blob = Bun.file(file);
  const contentLength = blob.size;
  if (dry) return { uploaded: path.basename(file), bytes: contentLength };

  const grant = parsed(
    AttachmentGrant,
    await publicApi(`/v1/payables/${payableId}/attachments`, {
      method: "POST",
      body: { mimeType: "application/pdf", contentLength },
    }),
    `POST /v1/payables/${payableId}/attachments`,
  );
  const target = grant.url ?? grant.data?.url;
  const fields = grant.fields ?? grant.data?.fields ?? {};
  if (!target) throw new Error(`no upload url in attachment grant: ${JSON.stringify(grant).slice(0, 300)}`);

  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  form.append("file", blob, path.basename(file));

  // Timed out, not retried: an upload that stalled may still have landed, and a retry is
  // how the same receipt ends up attached twice.
  const res = await fetch(target, { method: grant.method ?? "POST", body: form, signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`receipt upload → HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return { uploaded: path.basename(file), bytes: contentLength };
}

export type SetPaymentFieldsResult =
  | { dry: true; body: Record<string, unknown> }
  | { dry: false; set: string[] };

/**
 * Set custom fields on a *payment*, before its payable exists.
 *
 * `PUT /payments/{id}` takes `custom_fields_associations` — not `custom_fields`, which it
 * accepts and silently ignores, returning 200. The association array is a full
 * replacement and the same request carries `costCenterId`, so both are read-modify-write:
 * anything not sent back is dropped.
 */
export async function setPaymentFields(
  context: BrowserContext,
  paymentId: string,
  fields: Record<string, string>,
  { schema, memberId, dry }: { schema: LiveSchema; memberId: string; dry: boolean },
): Promise<SetPaymentFieldsResult> {
  const payment = await internalApiAs(InternalPayment, context, "GET", `/payments/${paymentId}`);

  if (payment.user_id !== memberId)
    throw new GuardError(`payment ${paymentId} belongs to ${payment.user_id}, not ${memberId}`);
  if (payment.accounted_at) throw new GuardError(`payment ${paymentId} was accounted at ${payment.accounted_at}`);

  // The cost centre rides along in this request; losing it would be a silent regression.
  const costCenterId = payment.cost_center?.id ?? null;
  if (!costCenterId) throw new GuardError(`payment ${paymentId} has no cost centre to preserve`);

  const resolved = resolveAll(schema, fields);

  const keep = payment.custom_fields
    .filter((a) => a.field?.id && !resolved.some((r) => r.fieldId === a.field?.id))
    .map((a) => ({ customFieldId: a.field?.id, customFieldValueId: a.value?.id, value: a.value?.value }));

  const body = {
    id: paymentId,
    costCenterId,
    custom_fields_associations: [
      ...keep,
      ...resolved.map((r) => ({ customFieldId: r.fieldId, customFieldValueId: r.valueId, value: r.valueName })),
    ],
  };
  if (dry) return { dry: true, body };
  await internalApi(context, "PUT", `/payments/${paymentId}`, body);
  return { dry: false, set: resolved.map((r) => `${r.fieldName}=${r.valueName}`) };
}

/**
 * Attach a receipt to a *payment*, before its payable exists.
 *
 * This matters for the SLA. The public attachment endpoint needs a payableId, and Spendesk
 * only creates the payable two days after the transaction — two thirds of the three-day
 * fuse gone before anything can be attached. The app itself posts multipart to
 * `/api/{companyId}/invoices/{paymentId}`, which works from day 0.
 *
 * `POST /payments/{id}/invoices` is a different, account-owner-only route: it answers 403
 * for a normal member and is not this.
 */
export async function attachReceiptToPayment(
  context: BrowserContext,
  paymentId: string,
  file: string,
  { dry }: { dry: boolean },
): Promise<UploadResult> {
  const buffer = Buffer.from(await Bun.file(file).arrayBuffer());
  if (dry) return { uploaded: path.basename(file), bytes: buffer.length };

  const res = await context.request.post(`${INTERNAL_API}/api/${COMPANY_ID}/invoices/${paymentId}`, {
    headers: { origin: APP, referer: `${APP}/` },
    // The field name is "invoices" — a "file" field earns 422 "no invoices in the http request".
    multipart: {
      invoices: { name: path.basename(file), mimeType: "application/pdf", buffer },
    },
    timeout: 60_000,
  });
  const text = await res.text();
  if (!res.ok()) throw new Error(`attaching ${path.basename(file)} → HTTP ${res.status()}: ${text.slice(0, 300)}`);
  return { uploaded: path.basename(file), bytes: buffer.length };
}

const RESOLVE_PAYMENTS = `query FetchPayments($companyId: String!, $first: Int, $filtersV1: [PaymentsFilters], $filtersV2: [JSON]) {
  company(id: $companyId) {
    payments(orderBy: PAID_DATE_NULL_THEN_DESC, first: $first, filters: $filtersV1, filters_v2: $filtersV2) {
      edges { node { databaseId description amount_declared currency_declared paid_at supplier { name } } }
    }
  }
}`;

/**
 * Join a payable to the payment id the description PUT needs.
 *
 * The public API never exposes it, so it comes from the app's GraphQL — but the two sides
 * do not agree on dates: GraphQL `paid_at` is the settlement timestamp (2026-08-30T10:34Z)
 * while the payable's `payableDate` is the transaction date (2026-08-29). Matching on an
 * exact date therefore never joined anything.
 *
 * So amount and currency select the candidates, proximity in time only orders them, and
 * the *confirmation* does the real work: ask the public API which payable a given
 * paymentId belongs to and require it to be ours. No confirmation, no write — which is
 * what makes it safe to match loosely.
 */
export async function resolvePaymentId(
  context: BrowserContext,
  payment: PayableItem,
  { memberId }: { memberId: string },
): Promise<string | null> {
  const nodes = await fetchPayments(context, { memberId, first: 60, query: RESOLVE_PAYMENTS });

  const target = new Date(`${payment.paidAt}T00:00:00Z`).getTime();
  const candidates = nodes
    .filter(
      (n) =>
        // amount_declared arrives as a string ("22", "406.98")
        Math.abs(Number(n.amount_declared) - payment.amount) < 0.005 && n.currency_declared === payment.currency,
    )
    .sort(
      (x, y) =>
        Math.abs(new Date(x.paid_at ?? 0).getTime() - target) - Math.abs(new Date(y.paid_at ?? 0).getTime() - target),
    );

  for (const candidate of candidates.slice(0, 5)) {
    const ids = await payablesForPayment(candidate.databaseId);
    if (ids.includes(payment.payableId)) return candidate.databaseId;
  }
  return null;
}

/** The payment id for any queue item, or null when the join cannot be confirmed. */
export async function paymentIdFor(
  context: BrowserContext,
  item: QueueItem,
  { memberId }: { memberId: string },
): Promise<string | null> {
  if (item.kind === "payment") return item.paymentId;
  return resolvePaymentId(context, item, { memberId }).catch(() => null);
}
