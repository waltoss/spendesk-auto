// The verifier is what stops a silent failure. 14 of the 25 files the previous version
// produced were ~2.9KB tryPrintPageAsPdf() output with no extractable text — a page that
// never rendered, saved and reported as a success (DESIGN §10).
//
// The two fixtures are real files from that directory, and they are gitignored: they are
// Thomas's actual invoices, and this repo is meant to be cloned by colleagues. When they
// are absent the golden tests skip and say so; the synthetic ones always run.
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { inspectPdf, statesAmount } from "../src/vendors/index.ts";

const FIXTURES = path.resolve(import.meta.dir, "../test/fixtures");
const have = (name: string): boolean => existsSync(path.join(FIXTURES, name));

/**
 * bun:test has no "skip with a reason" argument, so the reason goes into the name — it
 * still has to be visible in the output, or an absent fixture looks like a passing test.
 */
const golden = (file: string, name: string, fn: () => Promise<void>): void => {
  if (have(file)) test(name, fn);
  else test.skip(`${name}  [skipped: test/fixtures/${file} missing]`, fn);
};

test("an amount is recognised however the vendor chose to format it", () => {
  expect(statesAmount("Total due US$20.00 for the period", 20)).toBe(true);
  expect(statesAmount("Montant total : 266,49 €", 266.49)).toBe(true); // French decimal comma
  expect(statesAmount("Total 1,234.56 USD", 1234.56)).toBe(true); // thousands separator
  expect(statesAmount("Total 1 234,56 €", 1234.56)).toBe(true); // French thousands space
});

test("a near miss is not a match", () => {
  expect(statesAmount("Total due US$20.00", 200)).toBe(false);
  expect(statesAmount("Invoice for 266.48 EUR", 266.49)).toBe(false); // one cent out is still wrong
});

test("something that is not a PDF at all is rejected", async () => {
  const file = path.join(os.tmpdir(), `not-a-pdf-${process.pid}.pdf`);
  await Bun.write(file, "<html>Sign in to continue</html>");
  try {
    const info = await inspectPdf(file);
    expect(info.isPdf).toBe(false);
    expect(info.readable).toBe(false);
  } finally {
    await Bun.file(file).unlink().catch(() => {});
  }
});

golden("readable.pdf", "the golden readable invoice is accepted", async () => {
  const info = await inspectPdf(path.join(FIXTURES, "readable.pdf"));
  expect(info.isPdf).toBe(true);
  expect(info.readable).toBe(true); // expected extractable text
  // It is the real Cursor invoice for August 2026: the verifier must find its amount.
  expect(statesAmount(info.text, 20)).toBe(true); // US$20.00 should be found
  expect(statesAmount(info.text, 21)).toBe(false); // and a different amount should not be
});

golden("blank.pdf", "the golden blank invoice is rejected", async () => {
  const info = await inspectPdf(path.join(FIXTURES, "blank.pdf"));
  // it really is a PDF — that is why size alone never caught it
  expect(info.isPdf).toBe(true);
  // but there is nothing to read, so it must not be attached
  expect(info.readable).toBe(false);
});
