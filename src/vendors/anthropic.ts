// Anthropic bills through Stripe, but unlike Cursor it does not need the hosted invoice
// page: the console's own API returns a direct PDF link per invoice.
//
// So this adapter reads `/api/organizations/{org}/invoices` rather than scraping the table.
// The org id is intercepted from the page's own request instead of being hardcoded — an
// id pasted from a HAR is a fact about one account on one day, and would fail silently for
// anyone else, or after a re-org.
import path from "node:path";
import { z } from "zod";
import type { BrowserContext, Page } from "playwright";
import type { VendorEntry } from "../types.ts";
import { OUT } from "./index.ts";

const BILLING = "https://platform.claude.com/settings/billing";
const INVOICES = /\/api\/organizations\/[^/]+\/invoices(\?|$)/;

/**
 * Only invoices from the last fortnight are offered as candidates.
 *
 * `fetchInvoice` matches on amount alone and refuses when several entries tie — and credit
 * top-ups repeat the same round amount for months ($120.00 appears four times here). The
 * charge being completed is at most three days old, so anything older cannot be it, and
 * including it would turn every top-up into an unresolvable tie.
 */
const WINDOW_DAYS = 14;

const Invoice = z.object({
  type: z.string().nullish(),
  invoice_status: z.string().nullish(),
  effective_at: z.string().nullish(),
  /** Minor units: 12000 is $120.00. */
  amount: z.number(),
  download_url: z.string().nullish(),
  hosted_invoice_url: z.string().nullish(),
});
const InvoicesResponse = z.object({ invoices: z.array(Invoice).default([]) });

/**
 * Signed out, platform.claude.com still serves a page titled "Billing | Claude Platform"
 * at this exact URL — the URL and the title both look like success. So this asserts a
 * positive marker of the signed-in console; the absence of a sign-in button is also what
 * a page that has not finished rendering looks like.
 */
export async function loggedOut(page: Page): Promise<boolean> {
  await page.goto(BILLING, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(2000);
  const text = await page.evaluate(() => document.body.innerText);
  if (/Continue with (Google|email|SSO)/i.test(text)) return true;
  return !(/Organization settings/i.test(text) && /Invoices?/i.test(text));
}

export async function list(page: Page): Promise<VendorEntry[]> {
  // Arm the listener before navigating: the request fires during the page load.
  const waiting = page.waitForResponse((r) => INVOICES.test(r.url()) && r.status() === 200, { timeout: 45_000 });
  await page.goto(BILLING, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const { invoices } = InvoicesResponse.parse(await (await waiting).json());

  const cutoff = Date.now() - WINDOW_DAYS * 864e5;
  return invoices
    .filter((i) => i.effective_at && new Date(i.effective_at).getTime() >= cutoff)
    .map((i) => ({
      url: i.download_url ?? i.hosted_invoice_url ?? undefined,
      date: (i.effective_at ?? "").slice(0, 10) || null,
      amount: i.amount / 100,
      // The API states no currency. This organisation is billed in USD, and saying so is
      // the safer error: a EUR charge would then fail to match and escalate, rather than
      // silently attaching an invoice in the wrong currency.
      currency: "USD",
      status: i.invoice_status ?? null,
    }));
}

export async function download(context: BrowserContext, _page: Page, entry: VendorEntry): Promise<string> {
  if (!entry.url) throw new Error("this Anthropic invoice has no download link");
  // download_url is the PDF itself, so no click-through is needed — but it is a Stripe URL
  // carrying its own signed token, hence the browser context rather than a bare fetch.
  const res = await context.request.get(entry.url, { timeout: 60_000 });
  if (!res.ok()) throw new Error(`Anthropic invoice download → HTTP ${res.status()}`);
  const file = path.join(OUT, `anthropic-${entry.date ?? "undated"}-${Number(entry.amount).toFixed(2)}.pdf`);
  await Bun.write(file, await res.body());
  return file;
}

/** The amount is checked by the caller; this only asserts whose invoice it is. */
export function verify(text: string): string | null {
  return /anthropic/i.test(text) ? null : "the PDF does not name Anthropic";
}
