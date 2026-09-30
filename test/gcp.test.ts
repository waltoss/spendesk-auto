// GCP threshold debits: 500 € every time, no facture, a receipt that names the payment
// rather than the billing account. Each of those broke the monthly-invoice assumptions.
import { expect, test } from "bun:test";
import { isoDay, verify } from "../src/vendors/gcp.ts";
import { candidatesFor } from "../src/vendors/index.ts";
import type { VendorEntry } from "../src/types.ts";

const entry = (over: Partial<VendorEntry>): VendorEntry => ({
  account: "012512-2A6C67-A63A08",
  date: null,
  amount: "0",
  currency: "EUR",
  ...over,
});

test("French timeline dates become ISO days, and periods do not", () => {
  expect(isoDay("25 sept. 2026")).toBe("2026-09-25");
  expect(isoDay("1 août 2026")).toBe("2026-08-01");
  expect(isoDay("3 déc. 2026")).toBe("2026-12-03");
  expect(isoDay("1–30 sept. 2026")).toBeNull();
});

test("a lone amount match needs no date", () => {
  const hits = candidatesFor([entry({ amount: "91.25", date: "1–30 sept. 2026" })], { amount: 91.25, currency: "EUR" });
  expect(hits).toHaveLength(1);
});

test("equal threshold debits are told apart by day", () => {
  const entries = [
    entry({ ref: "A1111111111", amount: "500.00", date: "2026-08-12" }),
    entry({ ref: "A2222222222", amount: "500.00", date: "2026-09-25" }),
  ];
  const hits = candidatesFor(entries, { amount: 500, currency: "EUR", paidAt: "2026-09-26" });
  expect(hits.map((h) => h.ref)).toEqual(["A2222222222"]);
});

test("a tie with no day to break it stays a tie — refused, not guessed", () => {
  const entries = [
    entry({ account: "A", ref: "A1111111111", amount: "500.00", date: "2026-09-25" }),
    entry({ account: "B", ref: "A2222222222", amount: "500.00", date: "2026-09-25" }),
  ];
  expect(candidatesFor(entries, { amount: 500, currency: "EUR", paidAt: "2026-09-25" })).toHaveLength(2);
  expect(candidatesFor(entries, { amount: 500, currency: "EUR" })).toHaveLength(2);
});

test("a period-dated entry drops out of a tie rather than winning it", () => {
  const entries = [
    entry({ amount: "500.00", date: "1–31 août 2026" }),
    entry({ ref: "A2222222222", amount: "500.00", date: "2026-09-25" }),
  ];
  expect(candidatesFor(entries, { amount: 500, currency: "EUR", paidAt: "2026-09-25" }).map((h) => h.ref)).toEqual([
    "A2222222222",
  ]);
});

test("a receipt is checked against its payment number, a facture against its account", () => {
  const receipt = "Reçu du paiement 500,00 € N° de paiement A89749075942351207 Google Cloud France SARL";
  expect(verify(receipt, entry({ ref: "A89749075942351207" }))).toBeNull();
  expect(verify(receipt, entry({ ref: "A00000000000000000" }))).toMatch(/does not name payment/);
  expect(verify("Facture GCFRD1 compte 012512-2A6C67-A63A08", entry({}))).toBeNull();
  expect(verify("Facture GCFRD1 compte 0161AF-0347D6-59B14E", entry({}))).toMatch(/billing account/);
});
