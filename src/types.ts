// The vocabulary of the system, in one place.
//
// The original JavaScript modelled all of this as `any`, which is exactly where its
// sharp edges lived: a payment and a payable are *not* the same thing (one exists from
// day 0 and knows its own id, the other appears two days later and has a version), and
// a decision that says "ask a human" carries different data from one that says "write
// these fields". Both are discriminated unions here so the compiler enforces the
// difference the comments used to have to explain.

// --------------------------------------------------------------------------- results

/**
 * A failure that is expected and handled, rather than exceptional.
 *
 * Used where the old code already returned `{ file } | { error }` — invoice retrieval and
 * label resolution. Guards still throw, because a guard tripping is not a normal outcome.
 */
export type Result<T, E = string> = { ok: true; value: T } | { ok: false; error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

// ----------------------------------------------------------------------- the queue

/** What Spendesk says is missing. `label` is the human-facing field name. */
export type Need =
  | { kind: "field"; label: string; fieldId?: string }
  | { kind: "description" }
  | { kind: "receipt" }
  | { kind: "costCenter" }
  | { kind: "supplier" };

export type CompletionState = "complete" | "incomplete" | (string & {});

interface QueueItemCommon {
  supplier: string | null;
  description: string;
  /** NATIVE amount (USD 20.00), never functionalAmount — DESIGN §8.6. */
  amount: number;
  currency: string;
  paidAt: string;
  /** The Spendesk card the charge was made on. Null on the payables path, which cannot
   *  see it — so a card rule simply does not match there, rather than matching wrongly. */
  cardId: string | null;
  hoursRemaining: number | null;
  hasReceipt: boolean;
  fields: Record<string, string>;
  needs: Need[];
  completionState: CompletionState;
}

/**
 * The transaction. Exists from day 0, so this is the path that meets the SLA.
 * Every write we need works here, through the app's own API.
 */
export interface PaymentItem extends QueueItemCommon {
  kind: "payment";
  paymentId: string;
}

/**
 * The accounting document. Created two days after the transaction, but reachable with
 * the public API alone, so it survives a dead session.
 */
export interface PayableItem extends QueueItemCommon {
  kind: "payable";
  payableId: string;
  /** From /payables/search: toPrepare | toExport | exported. Never compared to the GET's
   *  bookkeepingStatus — different vocabularies (DESIGN §8.6). */
  searchState: string | null;
  version: number | null;
}

export type QueueItem = PaymentItem | PayableItem;

// ------------------------------------------------------------------------- the rules

/**
 * The single list of vendor adapters. The rules-file schema validates against this same
 * array, so adding an adapter cannot leave a stale enum that rejects a rule naming it.
 */
export const VENDOR_NAMES = ["anthropic", "cursor", "gcp"] as const;
export type VendorName = (typeof VENDOR_NAMES)[number];

/** What a `description(...)` function is handed. */
export interface RuleContext {
  month: string;
  amount: number;
  currency: string;
  date: string;
  supplier: string | null;
}

export type DescriptionFn = (context: RuleContext) => string;

export interface RuleWhen {
  supplier?: RegExp;
  description?: RegExp;
  currency?: string;
  amount?: number;
  /**
   * A Spendesk card id. Useful where the supplier is not: a card dedicated to one project
   * identifies the project even on a fresh authorisation, which carries no supplier and no
   * description at all. Exact match — these are opaque ids, not names.
   */
  card?: string;
  /** Not in the Spendesk data — resolved from payments.google.com by amount. */
  gcpAccount?: string;
}

/** `{ "Catégorie de dépense": { Sales: /client|prospect/i, ... } }` */
export type Derive = Record<string, Record<string, RegExp>>;

export interface RuleAsk {
  question: string;
  derive?: Derive;
}

export interface Rule {
  name: string;
  when?: RuleWhen;
  /** Labels, never ids: "Catégorie de dépense" -> "IT Costs". */
  fields?: Record<string, string>;
  description?: string | DescriptionFn;
  /** Which vendor adapter fetches the PDF, if one can. */
  invoice?: VendorName;
  /** Use instead of `fields` when only a human can know the answer. */
  ask?: RuleAsk;
}

export interface RulesFile {
  me: { email: string };
  defaults: Record<string, string>;
  rules: Rule[];
}

// ---------------------------------------------------------------------- the decision

export type Decision =
  /** Everything is derivable: write it. */
  | { kind: "auto"; rule: Rule; fields: Record<string, string>; description: string | null; invoice: VendorName | null }
  /** Only a human knows: one question, one reply, both category and description. */
  | { kind: "ask"; rule: Rule; question: string; derive: Derive; fields: Record<string, string> }
  /** A rule keyed on something Spendesk cannot tell us — look it up, then match again. */
  | { kind: "resolve"; key: "gcpAccount"; vendor: VendorName; candidates: Rule[] }
  /** No rule matches. Escalate, never guess. */
  | { kind: "unknown"; note?: string };

// ----------------------------------------------------------------------- escalations

export interface Escalation {
  payment: QueueItem;
  reason: string;
  /** True when `reason` is a question the user should reply to. */
  ask?: boolean;
  rule?: Rule;
}

// --------------------------------------------------------------------------- vendors

/** One invoice as a vendor's own UI lists it, before we have decided anything. */
export interface VendorEntry {
  /** The hosted-invoice page (Cursor) — where the PDF has to be clicked out of. */
  url?: string;
  /** The account-detail page this entry was read from (GCP). */
  href?: string;
  /** GCP billing account id; a document that does not name it is the wrong document. */
  account?: string | null;
  date: string | null;
  /** Kept as the vendor printed it; compared with Number(). */
  amount: string | number | null;
  currency: string | null;
  status?: string | null;
}

/** What a charge needs to look like for an adapter to find its invoice. */
export interface InvoiceTarget {
  amount: number;
  currency: string;
}
