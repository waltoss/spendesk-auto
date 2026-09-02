// Cursor bills through Stripe. Headless, no interaction.
//
// The dashboard lists rows with date + amount + a link to the Stripe hosted invoice. The
// PDF is only reachable by clicking "Download invoice" on that page — the hosted page is
// a 745-byte JS shim, so plain HTTP sees nothing. Note "Download invoice", not "Download
// receipt": the latter is a different document and is what produced the stray
// Receipt-*.pdf files in the old invoices/ directory.
import path from "node:path";
import type { BrowserContext, Page } from "playwright";
import type { VendorEntry } from "../types.ts";
import { OUT, redirectedAway } from "./index.ts";

const DASHBOARD = "https://cursor.com/dashboard?tab=billing";

export async function loggedOut(page: Page): Promise<boolean> {
  await page.goto(DASHBOARD, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(2000);
  // Signing out bounces to authenticator.cursor.sh, which is a different host — and it
  // sits behind a Cloudflare challenge, so its page text says nothing about signing in.
  return redirectedAway(page, "cursor.com");
}

export async function list(page: Page): Promise<VendorEntry[]> {
  const rows = await page.$$eval('a[href*="invoice.stripe.com"]', (as) =>
    as.map((a) => ({
      url: (a as HTMLAnchorElement).href,
      row:
        (a.closest("tr,li,div[class*=row],div") ?? a.parentElement)?.textContent
          ?.replace(/\s+/g, " ")
          .trim()
          .slice(0, 160) ?? "",
    })),
  );
  return rows.map(({ url, row }) => {
    const m = /([A-Z][a-z]{2}\s+\d{1,2},\s+\d{4}).*?([\d,]+\.\d{2})\s*([A-Z]{3})/.exec(row);
    return {
      url,
      date: m?.[1] ?? null,
      amount: m?.[2]?.replace(/,/g, "") ?? null,
      currency: m?.[3] ?? null,
      status: /paid/i.test(row) ? "paid" : /open|due/i.test(row) ? "open" : null,
    };
  });
}

export async function download(context: BrowserContext, _page: Page, entry: VendorEntry): Promise<string> {
  if (!entry.url) throw new Error("this Cursor row has no hosted-invoice link");
  const page = await context.newPage();
  try {
    await page.goto(entry.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});

    const button = page.getByRole("button", { name: /^Download invoice$/i }).first();
    await button.waitFor({ state: "visible", timeout: 20_000 });

    const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 30_000 }), button.click()]);
    const name = (dl.suggestedFilename() || `cursor-${Date.now()}.pdf`).replace(/[/\\]/g, "_");
    const file = path.join(OUT, name);
    await dl.saveAs(file);
    return file;
  } finally {
    await page.close().catch(() => {});
  }
}
