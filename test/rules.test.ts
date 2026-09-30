// Matching decides what gets written autonomously. The asymmetry that matters: an
// unmatched payable costs one email, a wrongly matched one is silently wrong in Theodo's
// accounts. So these tests care most about what does NOT match.
import { expect, test } from "bun:test";
import { match, requiredFields, deriveFromReply, type Matchable } from "../src/rules.ts";
import { defaults, rules } from "../src/config.ts";
import type { Decision } from "../src/types.ts";

const payment = (over: Partial<Matchable>): Matchable => ({
  supplier: null,
  description: "",
  amount: 0,
  currency: "EUR",
  paidAt: "2026-08-26",
  cardId: null,
  ...over,
});

/** Assert the branch and narrow to it, so the rest of the test reads the right fields. */
function expectKind<K extends Decision["kind"]>(d: Decision, kind: K): Extract<Decision, { kind: K }> {
  expect(d.kind).toBe(kind);
  return d as Extract<Decision, { kind: K }>;
}

test("the required fields are exactly the three Spendesk enforces", () => {
  expect(requiredFields({ defaults, rules }).sort()).toEqual(
    [
      "1) Cette dépense concerne-t-elle votre budget confort ?",
      "2) A refacturer au client ?",
      "Catégorie de dépense",
    ].sort(),
  );
});

test("Cursor is automatic, with the defaults merged in", () => {
  const d = expectKind(match(payment({ supplier: "cursor", amount: 20, currency: "USD" }), { defaults, rules }), "auto");
  expect(d.fields["Catégorie de dépense"]).toBe("IT Costs");
  expect(d.fields["1) Cette dépense concerne-t-elle votre budget confort ?"]).toBe("Non");
  expect(d.description).toBe("Cursor — abonnement IA août 2026");
  expect(d.invoice).toBe("cursor");
});

test("an unknown supplier is escalated, not guessed", () => {
  expect(match(payment({ supplier: "Some Shop SARL", amount: 42 }), { defaults, rules }).kind).toBe("unknown");
});

test("supplier matching ignores accents in either direction", () => {
  // Spendesk holds "Hôtel Negrecoste"; the rule is written /hotel/.
  const d = expectKind(
    match(payment({ supplier: "Hôtel Negrecoste Aix en Provence", amount: 17.08 }), { defaults, rules }),
    "ask",
  );
  expect(d.question).toBe("Who was this meal with, and why?");
});

test("meals ask rather than assume, and carry no category", () => {
  const d = expectKind(match(payment({ supplier: "RESTAURANTS DIVERS", amount: 31 }), { defaults, rules }), "ask");
  // the category is what the question is for
  expect(d.fields["Catégorie de dépense"]).toBeUndefined();
});

test("ElevenLabs needs the amount too, because the supplier name is junk", () => {
  const junk = { supplier: "FOURNISSEURS DIVERS", currency: "USD" };
  expect(match(payment({ ...junk, amount: 22 }), { defaults, rules }).kind).toBe("auto");
  expect(match(payment({ ...junk, amount: 350 }), { defaults, rules }).kind).toBe("unknown");
});

test("a GCP payable asks for a billing-account lookup instead of picking a rule", () => {
  const p = payment({ supplier: "Google Cloud EMEA Ltd", amount: 309.58 });
  const d = expectKind(match(p, { defaults, rules }), "resolve");
  expect(d.key).toBe("gcpAccount");
  expect(d.vendor).toBe("gcp");
  // the whole point is that several accounts are plausible
  expect(d.candidates.length).toBeGreaterThan(1);
});

test("once the billing account is known, the right GCP rule applies", () => {
  const p = payment({ supplier: "Google Cloud EMEA Ltd", amount: 309.58 });
  const d = expectKind(match(p, { defaults, rules }, { gcpAccount: "012512-2A6C67-A63A08" }), "auto");
  // Radical Academy is Training, not IT Costs
  expect(d.fields["Catégorie de dépense"]).toBe("Training");
});

test("an unrecognised billing account is escalated", () => {
  const p = payment({ supplier: "Google Cloud EMEA Ltd", amount: 309.58 });
  const d = expectKind(match(p, { defaults, rules }, { gcpAccount: "999999-999999-999999" }), "unknown");
  expect(d.note).toMatch(/has no rule/);
});

test("a reply that answers the question derives the category", () => {
  const d = expectKind(match(payment({ supplier: "RESTAURANTS DIVERS", amount: 31 }), { defaults, rules }), "ask");
  const { fields, missed } = deriveFromReply("dej avec Regis medina radical academy", d.rule.ask?.derive);
  expect(fields["Catégorie de dépense"]).toBe("Training");
  // what the reply does not say stays unanswered
  expect(missed).toContain("2) A refacturer au client ?");
});

test("a reply that answers nothing derives nothing", () => {
  const d = expectKind(match(payment({ supplier: "RESTAURANTS DIVERS", amount: 31 }), { defaults, rules }), "ask");
  const { fields } = deriveFromReply("thanks", d.rule.ask?.derive);
  expect(fields).toEqual({});
});

test("a project card matches even with no supplier, description or amount", () => {
  // The day-0 shape: an authorisation, before Spendesk knows the merchant.
  const d = match(payment({ cardId: "eniy627_5pp600", amount: 120, currency: "USD" }), { defaults, rules });
  const auto = expectKind(d, "auto");
  expect(auto.rule.name).toBe("Radical Academy card");
  expect(auto.fields["Catégorie de dépense"]).toBe("Training");
});

test("a card rule never matches a payable, which has no card", () => {
  // The payables path reports cardId: null. If `when.card` matched that, every unmatched
  // payable would be filed under one project's category — silently wrong in the accounts.
  expect(match(payment({ cardId: null, amount: 120, currency: "USD" }), { defaults, rules }).kind).toBe("unknown");
});

test("a supplier rule still wins over the card it happens to share", () => {
  // GCP Radical Academy is on the same card, but has its own description and invoice
  // adapter; first-rule-wins must keep it ahead of the catch-all card rule.
  const d = match(
    payment({ cardId: "eniy627_5pp600", supplier: "Google Cloud", amount: 406.98 }),
    { defaults, rules },
  );
  expect(d.kind).toBe("resolve"); // GCP still needs its billing account resolved
});

test("a settled Anthropic charge on the project card keeps its category and its invoice", () => {
  // Once the charge settles Spendesk names the supplier. The generic "Anthropic / Claude"
  // rule then used to claim it — IT Costs, and no adapter, so the receipt never came.
  const d = expectKind(
    match(payment({ cardId: "eniy627_5pp600", supplier: "Anthropic", amount: 108.04, currency: "USD" }), {
      defaults,
      rules,
    }),
    "auto",
  );
  expect(d.fields["Catégorie de dépense"]).toBe("Training");
  expect(d.invoice).toBe("anthropic");
});

test("an Anthropic payable with no card can still fetch its invoice", () => {
  const d = expectKind(match(payment({ supplier: "Anthropic", amount: 108.04, currency: "USD" }), { defaults, rules }), "auto");
  expect(d.rule.name).toBe("Anthropic / Claude");
  expect(d.invoice).toBe("anthropic");
});
