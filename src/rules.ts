// The matcher. config/rules.ts is the data; this is the only place that interprets it.
//
// First rule wins, top to bottom. Anything unmatched is escalated — never guessed. That
// asymmetry is the whole safety story: a wrong field is silently wrong in Theodo's
// accounts, whereas an escalation costs one email.
//
// The return type is a discriminated union, so "what do I do with this payment?" has
// exactly four answers and the compiler will not let a caller forget one.
import type { Decision, Derive, QueueItem, Rule, RuleContext, RuleWhen } from "./types.ts";

export interface RuleSet {
  defaults: Record<string, string>;
  rules: Rule[];
}

/** What the matcher needs to know about a charge. Both queue shapes satisfy it. */
export type Matchable = Pick<QueueItem, "supplier" | "description" | "amount" | "currency" | "paidAt">;

/**
 * Which fields must be filled for Spendesk to consider a payable complete.
 * Derived from the rules file rather than hardcoded, so it stays true if the required
 * set changes. (The internal completions oracle is the authority once we have a
 * session; this is the offline approximation, and it agrees on the three fields
 * observed on every complete payable.)
 */
export function requiredFields({ defaults, rules }: RuleSet): string[] {
  const labels = new Set<string>(Object.keys(defaults));
  for (const rule of rules) {
    for (const label of Object.keys(rule.fields ?? {})) labels.add(label);
    for (const label of Object.keys(rule.ask?.derive ?? {})) labels.add(label);
  }
  return [...labels];
}

const monthOf = (isoDate: string): string =>
  new Date(`${isoDate}T00:00:00Z`).toLocaleDateString("fr-FR", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

/**
 * Supplier names arrive as Spendesk holds them: "Hôtel Negrecoste", "RESTAURANTS DIVERS".
 * A rule written /hotel/ should match "Hôtel" and a rule written /hôtel/ should match
 * "Hotel", so patterns are tried against both the raw name and its de-accented form.
 */
const deaccent = (s: string): string => s.normalize("NFD").replace(/\p{Diacritic}/gu, "");
const testsName = (pattern: RegExp, name: string | null | undefined): boolean =>
  pattern.test(name ?? "") || pattern.test(deaccent(name ?? ""));

/** Does a `when` clause match, ignoring keys that need an external lookup? */
function matchesLocally(when: RuleWhen, payment: Matchable): boolean {
  if (when.supplier && !testsName(when.supplier, payment.supplier)) return false;
  if (when.currency && when.currency !== payment.currency) return false;
  if (when.amount !== undefined && Math.abs(when.amount - payment.amount) > 0.005) return false;
  if (when.description && !testsName(when.description, payment.description)) return false;
  return true;
}

export interface ResolvedFacts {
  /** Which GCP billing account produced this charge, once payments.google.com has said. */
  gcpAccount?: string;
}

export function match(payment: Matchable, { defaults, rules }: RuleSet, resolved: ResolvedFacts = {}): Decision {
  const candidates = rules.filter((r) => matchesLocally(r.when ?? {}, payment));
  const first = candidates[0];
  if (!first) return { kind: "unknown" };

  // Rules keyed on a GCP billing account cannot be told apart from Spendesk data alone —
  // the account lives at payments.google.com, matched by amount. Ask for that lookup
  // rather than picking one of them.
  const needsAccount = candidates.filter((r) => r.when?.gcpAccount);
  if (needsAccount.length) {
    const known = resolved.gcpAccount;
    const hit = known ? needsAccount.find((r) => r.when?.gcpAccount === known) : undefined;
    if (!hit) {
      return known
        ? { kind: "unknown", note: `GCP billing account ${known} has no rule` }
        : { kind: "resolve", key: "gcpAccount", vendor: "gcp", candidates: needsAccount };
    }
    return auto(hit, payment, defaults);
  }

  if (first.ask) {
    return {
      kind: "ask",
      rule: first,
      question: first.ask.question,
      derive: first.ask.derive ?? {},
      fields: { ...defaults },
    };
  }
  return auto(first, payment, defaults);
}

function auto(rule: Rule, payment: Matchable, defaults: Record<string, string>): Decision {
  const context: RuleContext = {
    month: monthOf(payment.paidAt),
    amount: payment.amount,
    currency: payment.currency,
    date: payment.paidAt,
    supplier: payment.supplier,
  };
  return {
    kind: "auto",
    rule,
    fields: { ...defaults, ...rule.fields },
    description: typeof rule.description === "function" ? rule.description(context) : rule.description ?? null,
    invoice: rule.invoice ?? null,
  };
}

export interface DerivedReply {
  fields: Record<string, string>;
  missed: string[];
}

/**
 * Turn a free-text reply ("dej avec Regis medina radical academy") into fields.
 * DESIGN §12: these patterns are untested against real replies — a derived value is a
 * suggestion, and anything underived is still an escalation.
 */
export function deriveFromReply(reply: string, derive: Derive | undefined): DerivedReply {
  const fields: Record<string, string> = {};
  const missed: string[] = [];
  for (const [label, options] of Object.entries(derive ?? {})) {
    const hit = Object.entries(options).find(([, pattern]) => pattern.test(reply));
    if (hit) fields[label] = hit[0];
    else missed.push(label);
  }
  return { fields, missed };
}
