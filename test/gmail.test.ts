// Subject-line parsing. These strings are copied verbatim from real Spendesk emails —
// inventing them would test the test.
import { test, expect } from "bun:test";
import { classify, parseAmount, blockWarning, resolveGws, type Signal } from "../src/signals/gmail.ts";

const at = new Date("2026-09-01T20:15:12Z");

test("a card purchase is recognised", () => {
  const s = classify("New purchase of €406.98 made with your Spendesk virtual card", at);
  expect(s?.kind).toBe("purchase");
  if (s?.kind !== "purchase") throw new Error("wrong kind");
  expect(s.amount).toBe(406.98);
  expect(s.currency).toBe("EUR");
  expect(s.subscription).toBe(false);
});

test("a subscription charge uses a different template and is flagged", () => {
  const s = classify("Google Cloud charged €33.47 for your subscription", at);
  if (s?.kind !== "purchase") throw new Error("wrong kind");
  expect(s.subscription).toBe(true);
  expect(s.amount).toBe(33.47);
});

test("the block warning is recognised without needing an amount", () => {
  const s = classify("Your account will be blocked in 24h due to missing receipts and mandatory payment", at);
  expect(s?.kind).toBe("block-warning");
});

test("a decline is recognised", () => {
  const s = classify("Your payment of €19.38 was declined", at);
  if (s?.kind !== "declined") throw new Error("wrong kind");
  expect(s.amount).toBe(19.38);
});

test("unrelated Spendesk mail is ignored, not guessed at", () => {
  expect(classify("Theodo's account statement August 2026", at)).toBeNull();
  expect(classify("New authentication method added to your account", at)).toBeNull();
  expect(classify("Hooray Thomas", at)).toBeNull();
});

test("amounts parse in both European and English formats", () => {
  expect(parseAmount("€1 234,56")).toEqual({ amount: 1234.56, currency: "EUR" });
  expect(parseAmount("€1,234.56")).toEqual({ amount: 1234.56, currency: "EUR" });
  expect(parseAmount("€9.40")).toEqual({ amount: 9.4, currency: "EUR" });
  expect(parseAmount("no money here")).toBeNull();
});

test("a stale block warning does not count as current", () => {
  const old: Signal[] = [{ kind: "block-warning", at: new Date(Date.now() - 5 * 864e5), subject: "x" }];
  expect(blockWarning(old)).toBeNull();
  const fresh: Signal[] = [{ kind: "block-warning", at: new Date(Date.now() - 2 * 36e5), subject: "x" }];
  expect(blockWarning(fresh)).not.toBeNull();
});

test("gws resolves to a durable path, not an ephemeral per-shell one", () => {
  const found = resolveGws();
  if (!found) return; // gws not installed on this machine; nothing to assert
  expect(found.bin).not.toContain("fnm_multishells");
  expect(found.bin).toContain("node-versions");
});
