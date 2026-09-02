// Every Spendesk response is parsed here before anything else looks at it.
//
// The JavaScript version trusted `any` at every boundary, and the failures that cost the
// most were precisely shape failures: a 200 that silently did nothing (`custom_fields`
// instead of `custom_fields_associations`), a search result whose amounts are in minor
// units while the filters take major ones, a values endpoint whose label key is `value`
// and not `name`. None of those are caught by a status code; all of them are caught by
// knowing the shape.
//
// Two deliberate choices:
//
//  * Objects are LOOSE. Spendesk adds fields; rejecting an unknown key would turn a
//    harmless addition into a broken card. We assert what we read, not what they send.
//  * Almost everything is `.nullish()`. A missing field must reach the guards as
//    undefined so they can refuse it, rather than being rejected here with a stack trace
//    that says nothing about which payable was at fault.
import { z } from "zod";

/** An array that tolerates null/absent, because half of these endpoints omit empties. */
const arrayOf = <T extends z.ZodType>(schema: T) =>
  z
    .array(schema)
    .nullish()
    .transform((v) => v ?? []);

/** Parse, or fail with a message that names the endpoint and the offending path. */
export function parsed<T>(schema: z.ZodType<T>, data: unknown, what: string): T {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const why = z.prettifyError(result.error).replace(/\s*\n\s*/g, " ").slice(0, 400);
  throw new Error(`${what}: unexpected response shape — ${why}`);
}

// ------------------------------------------------------------------------ public API

export const TokenResponse = z.looseObject({
  access_token: z.string(),
  /** Seconds (3600). Renewed a minute early. */
  expires_in: z.number().nullish(),
});

export const AnalyticalField = z.looseObject({ id: z.string(), name: z.string().nullish() });

/** DESIGN §8.6: the label key is `value`, not `name`, and pageSize caps at 30. */
export const AnalyticalValue = z.looseObject({ id: z.string(), value: z.string().nullish() });

export const User = z.looseObject({
  id: z.string(),
  email: z.string().nullish(),
  firstName: z.string().nullish(),
  lastName: z.string().nullish(),
});

/** One row of POST /v1/payables/search. `state` is toPrepare|toExport|exported. */
export const SearchPayable = z.looseObject({
  id: z.string(),
  memberId: z.string().nullish(),
  state: z.string().nullish(),
  creationDate: z.string().nullish(),
});

export const SearchResponse = z.looseObject({ payables: arrayOf(SearchPayable) });

export const AnalyticalProperty = z.looseObject({
  fieldId: z.string().nullish(),
  valueId: z.string().nullish(),
  /** GET /v1/payables/{id} resolves the labels for us — no id lookup needed (§8.1). */
  fieldName: z.string().nullish(),
  valueName: z.string().nullish(),
});

export const LineItem = z.looseObject({
  expenseAccount: z.looseObject({ id: z.string().nullish() }).nullish(),
  /** null is not the same as tax-exempt: guard (5) copies it verbatim. */
  vatAccount: z.looseObject({ id: z.string().nullish() }).nullish(),
  financial: z.looseObject({ grossAmount: z.number().nullish() }).nullish(),
  analyticalProperties: arrayOf(AnalyticalProperty),
  costCenterId: z.string().nullish(),
});

/** GET /v1/payables/{id}. Amounts are MINOR units here (1790 = 17.90). */
export const Payable = z.looseObject({
  id: z.string(),
  version: z.number().nullish(),
  userId: z.string().nullish(),
  amount: z.number().nullish(),
  currency: z.string().nullish(),
  exportedAt: z.string().nullish(),
  costCenterId: z.string().nullish(),
  description: z.string().nullish(),
  payableDate: z.string().nullish(),
  counterparty: z.looseObject({ name: z.string().nullish() }).nullish(),
  analyticalProperties: arrayOf(AnalyticalProperty),
  lineItems: arrayOf(LineItem),
});
export type Payable = z.infer<typeof Payable>;
export type LineItem = z.infer<typeof LineItem>;

export const AttachmentsResponse = z.looseObject({ data: arrayOf(z.unknown()) });

/** POST /v1/payables/{id}/attachments answers with a presigned upload. */
export const AttachmentGrant = z.looseObject({
  method: z.string().nullish(),
  url: z.string().nullish(),
  fields: z.record(z.string(), z.string()).nullish(),
  data: z
    .looseObject({ url: z.string().nullish(), fields: z.record(z.string(), z.string()).nullish() })
    .nullish(),
});

export const PatchPayableResponse = z
  .looseObject({ item: z.looseObject({ version: z.number().nullish() }).nullish() })
  .nullish();

// ---------------------------------------------------------------------- internal API

/**
 * GET /control-rules/completions/by-payment/{id} — the completeness oracle.
 * The required set genuinely varies per payment (one GCP charge needed none, another
 * two), so this is queried and never modelled.
 */
export const Completion = z.looseObject({
  state: z.string().nullish(),
  incompleteData: z
    .looseObject({
      /** Field *ids*, which is why the schema map has to work both ways. */
      missingCustomFields: arrayOf(z.string()),
      isDescriptionMissing: z.boolean().nullish(),
      isReceiptMissing: z.boolean().nullish(),
      isCostCenterMissing: z.boolean().nullish(),
      isSupplierMissing: z.boolean().nullish(),
    })
    .nullish(),
});

/** GET /api/{co}/payments/{id} — snake_case, unlike everything in the public API. */
export const InternalPayment = z.looseObject({
  user_id: z.string().nullish(),
  accounted_at: z.string().nullish(),
  cost_center: z.looseObject({ id: z.string().nullish() }).nullish(),
  custom_fields: arrayOf(
    z.looseObject({
      field: z.looseObject({ id: z.string().nullish() }).nullish(),
      value: z.looseObject({ id: z.string().nullish(), value: z.string().nullish() }).nullish(),
    }),
  ),
});

// -------------------------------------------------------------------------- GraphQL

/**
 * `databaseId` is the payment id the description PUT needs, and the public API accepts it
 * as a `paymentId` filter — the bridge between the two APIs (§8.1).
 * `amount_declared` arrives as a string ("22", "406.98"), in MAJOR units.
 */
export const PaymentNode = z.looseObject({
  databaseId: z.union([z.string(), z.number()]).transform((v) => String(v)),
  description: z.string().nullish(),
  completionState: z.string().nullish(),
  state: z.string().nullish(),
  amount_declared: z.union([z.string(), z.number()]).nullish(),
  currency_declared: z.string().nullish(),
  paid_at: z.string().nullish(),
  invoices: z.looseObject({ total: z.number().nullish() }).nullish(),
  invoice_lost: z.boolean().nullish(),
  invoice_invalid: z.boolean().nullish(),
  supplier: z.looseObject({ name: z.string().nullish() }).nullish(),
  costCenter: z.looseObject({ name: z.string().nullish() }).nullish(),
});
export type PaymentNode = z.infer<typeof PaymentNode>;

export const FetchPaymentsResponse = z.looseObject({
  errors: z.array(z.unknown()).nullish(),
  data: z
    .looseObject({
      company: z
        .looseObject({
          payments: z.looseObject({ edges: arrayOf(z.looseObject({ node: PaymentNode })) }).nullish(),
        })
        .nullish(),
    })
    .nullish(),
});
