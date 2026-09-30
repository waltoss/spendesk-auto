// GCP, entirely within payments.google.com — never the Cloud Console.
//
// The Console works but is ~400 requests and 3MB of Angular, and automating it produced
// "Google has temporarily blocked your account or network due to excessive automated
// requests" on a work account. That is a hard constraint, not a preference (DESIGN §10).
//
//   /home/subscriptionsandservices   one card per billing account, each with a "Gérer"
//                                    <button> whose ebaid URL is minted on click
//   /home/accountdetail?ebaid=...    renders inside a payments/u/0/embedded_landing_page
//                                    iframe; the Transactions card lists periods+amounts
//   "Afficher les transactions..."   opens a timelineview iframe listing the documents per
//                                    period. The Relevé carries data-download-url directly;
//                                    the facture (GCFRD…) is a menu button — clicking it
//                                    opens a menu whose "Téléchargement" item carries the
//                                    URL. Take the facture; the Relevé is a statement.
//
// Charges are not strictly monthly — each account has a payment threshold (500 € / 100 €)
// that triggers off-cycle charges. Retrieval is therefore driven by "Spendesk has a GCP
// payable with no receipt", never by a calendar.
//
// A threshold debit ("Débit lié au seuil") matches no period's closing balance and has no
// facture of its own: the facture comes at month end and covers the whole period. What it
// does have is a "Reçu du paiement" — its row in the timeline is a link that opens the
// receipt as an HTML page in a new tab, printed to PDF here. That receipt is what gets
// attached; missing these is how a 500 € charge sat escalated for five days.
import path from "node:path";
import type { BrowserContext, Frame, Page } from "playwright";
import type { VendorEntry } from "../types.ts";
import { OUT, redirectedAway } from "./index.ts";

const HOME = "https://payments.google.com/gp/w/u/0/home/subscriptionsandservices";

const innerText = (target: Page | Frame): Promise<string> =>
  target.evaluate(() => document.body?.innerText || "").catch(() => "");

export async function loggedOut(page: Page): Promise<boolean> {
  await page.goto(HOME, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForLoadState("networkidle", { timeout: 25_000 }).catch(() => {});
  return redirectedAway(page, "payments.google.com");
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: 25_000 }).catch(() => {});
  for (let i = 0; i < 20; i++) {
    if (/Google Cloud/i.test(await innerText(page))) return;
    await page.waitForTimeout(1000);
  }
}

/** "1 234,56 €" or "−500,00 €" -> "1234.56" / "500.00". The sign is the timeline's, not ours. */
const euros = (shown: string): string =>
  shown
    .replace(/[\s  €−-]/g, "")
    .replace(/\.(?=\d{3}\b)/g, "")
    .replace(",", ".");

const MONTHS: Record<string, number> = {
  janv: 1, févr: 2, mars: 3, avr: 4, mai: 5, juin: 6, juil: 7, août: 8, sept: 9, oct: 10, nov: 11, déc: 12,
};

/** "25 sept. 2026" -> "2026-09-25", or null for anything else (a period, a typo). */
export function isoDay(shown: string): string | null {
  const m = /^(\d{1,2})\s+([a-zéû]+)\.?\s+(\d{4})$/i.exec(shown.trim());
  const month = m ? MONTHS[m[2]!.toLowerCase()] : undefined;
  if (!m || !month) return null;
  return `${m[3]}-${String(month).padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
}

interface BillingAccount {
  account: string | null;
  href: string;
}

/** "Gérer" is a button with a jsaction — the ebaid URL only exists after the click. */
async function accounts(page: Page): Promise<BillingAccount[]> {
  if (!page.url().startsWith(HOME)) await page.goto(HOME, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await settle(page);

  const count = await page.getByRole("button", { name: /^Gérer$/ }).count();
  const out: BillingAccount[] = [];
  for (let i = 0; i < count; i++) {
    await page.goto(HOME, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await settle(page);
    await page
      .getByRole("button", { name: /^Gérer$/ })
      .nth(i)
      .click({ timeout: 20_000 })
      .catch(() => {});
    await page.waitForURL(/accountdetail/, { timeout: 30_000 }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(3000);

    // the billing account id renders inside the iframe, not the main document
    let account: string | null = null;
    for (let k = 0; k < 25 && !account; k++) {
      const f = page.frames().find((fr) => /embedded_landing_page/.test(fr.url()));
      if (f)
        account =
          /([0-9A-F]{6}-[0-9A-F]{6}-[0-9A-F]{6})/.exec((await innerText(f)).replace(/\s+/g, " "))?.[1] ?? null;
      if (!account) await page.waitForTimeout(1000);
    }
    if (page.url().includes("accountdetail")) out.push({ account, href: page.url() });
  }
  return out;
}

async function detailFrame(page: Page): Promise<Frame> {
  for (let i = 0; i < 30; i++) {
    const f = page.frames().find((fr) => /embedded_landing_page/.test(fr.url()));
    if (f && /€/.test(await innerText(f))) return f;
    await page.waitForTimeout(1000);
  }
  throw new Error("the account detail iframe never rendered");
}

export async function list(page: Page): Promise<VendorEntry[]> {
  const found = await accounts(page);
  const out: VendorEntry[] = [];

  for (const acc of found) {
    if (page.url() !== acc.href) {
      await page.goto(acc.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForTimeout(3000);
    }
    const frame = await detailFrame(page);
    const { dates, amounts } = await frame.evaluate(() => {
      const txt = (e: Element): string => ((e as HTMLElement).innerText || "").replace(/\s+/g, " ").trim();
      // Scope to the Transactions card: the account balance and the payment-threshold
      // figures otherwise get mixed in with the per-period amounts.
      const card = [...document.querySelectorAll("div,section")]
        .filter((c) => /(^|\s)Transactions(\s|$)/.test(txt(c)) && /\d{1,2}\s*[–-]\s*\d{1,2}/.test(txt(c)))
        .sort((a, b) => txt(a).length - txt(b).length)[0];
      if (!card) return { dates: [] as string[], amounts: [] as string[] };
      const leaves = [...card.querySelectorAll("*")].filter((e) => e.children.length === 0);
      return {
        dates: leaves.map(txt).filter((t) => /^\d{1,2}\s*[–-]\s*\d{1,2}\s+\S+\s+\d{4}$/.test(t)),
        amounts: leaves.map(txt).filter((t) => /^[\d  .,]+\s?€$/.test(t)),
      };
    });

    dates.forEach((date, k) =>
      out.push({
        account: acc.account,
        href: acc.href,
        date,
        amount: euros(amounts[k] ?? ""),
        currency: "EUR",
      }),
    );

    // Threshold debits are only itemised in the timeline: one more click per account, and
    // still inside payments.google.com. Not optional — without it a threshold charge can
    // be neither attributed to an account nor given a receipt.
    const timeline = await openTimeline(page, frame);
    for (const debit of await thresholdDebits(timeline))
      out.push({
        account: acc.account,
        href: acc.href,
        ref: debit.ref,
        date: isoDay(debit.date) ?? debit.date,
        amount: euros(debit.amount),
        currency: "EUR",
      });
  }
  return out;
}

/** "Afficher les transactions..." opens the timeline, in an iframe of its own. */
async function openTimeline(page: Page, summary: Frame): Promise<Frame> {
  await summary.getByText(/Afficher les transactions/i).first().click({ timeout: 20_000 });
  for (let i = 0; i < 30; i++) {
    const f = page.frames().find((fr) => /timelineview/.test(fr.url()));
    // Every period, billed or not, prints a closing balance — "Documents" alone would
    // wait forever on an account that has never been invoiced.
    if (f && /Solde de clôture/i.test(await innerText(f))) return f;
    await page.waitForTimeout(1000);
  }
  throw new Error("the transactions timeline never rendered");
}

/** The "Débit lié au seuil" rows: date, payment number, amount — as printed. */
async function thresholdDebits(timeline: Frame): Promise<{ date: string; ref: string; amount: string }[]> {
  return timeline.evaluate(() => {
    const txt = (e: Element): string => ((e as HTMLElement).innerText || "").replace(/\s+/g, " ").trim();
    return [...document.querySelectorAll("tr")].flatMap((tr) => {
      const cells = [...tr.querySelectorAll("td")].map(txt);
      const description = cells.find((c) => /^Débit lié au seuil/i.test(c));
      const ref = description ? /\b(A\d{10,})\b/.exec(description)?.[1] : undefined;
      if (!ref) return [];
      return [{ date: cells[0] ?? "", ref, amount: cells[cells.length - 1] ?? "" }];
    });
  });
}

/**
 * A GCP invoice names its own billing account, so the document can be checked against the
 * card we took it from. Amount alone would not catch pulling the right sum from the wrong
 * account — three accounts on one page makes that a real failure mode, not a hypothetical.
 */
export function verify(text: string, entry: VendorEntry): string | null {
  // A payment receipt names its payment number, not the billing account.
  if (entry.ref) return text.includes(entry.ref) ? null : `the receipt does not name payment ${entry.ref}`;
  if (!entry.account) return null;
  return text.includes(entry.account) ? null : `the PDF does not name billing account ${entry.account}`;
}

export async function download(context: BrowserContext, page: Page, entry: VendorEntry): Promise<string> {
  if (!entry.href) throw new Error("this GCP entry has no account-detail page to go back to");
  // Always reload: list() leaves the page on some account's timeline, and the URL alone
  // does not say which view is showing.
  await page.goto(entry.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(3000);

  // The summary card has no download control; the timeline view does.
  const timeline = await openTimeline(page, await detailFrame(page));
  if (entry.ref) return receipt(context, page, timeline, entry);

  const label = await factureFor(timeline, entry.amount);
  if (!label) throw new Error(`no facture found for a closing balance of ${String(entry.amount).replace(".", ",")} €`);

  // Clicking the facture row opens a menu ("Téléchargement" / "Générer une nouvelle
  // facture"). The row itself does nothing — clicking it and waiting for a download is
  // what failed before. The menu item carries the URL in data-download-url, so read it
  // and fetch it with the session cookies rather than racing a browser download.
  if (!(await expandCardFor(timeline, label)))
    throw new Error(`could not open the period card holding ${label}`);

  const row = timeline
    .locator(".b3id-document-zippy-line-item.jfk-freestanding-menu-button")
    .filter({ hasText: label })
    .first();
  await row.scrollIntoViewIfNeeded({ timeout: 15_000 }).catch(() => {});
  await row.click({ timeout: 20_000 });

  let href: string | null = null;
  for (let i = 0; i < 10 && !href; i++) {
    await page.waitForTimeout(500);
    href = await timeline.evaluate(() => {
      const menu = [...document.querySelectorAll(".goog-menu-vertical")].find(
        (m) => (m as HTMLElement).offsetParent !== null,
      );
      return menu?.querySelector("[data-download-url]")?.getAttribute("data-download-url") ?? null;
    });
  }
  if (!href) throw new Error(`the menu for ${label} offered no download link`);

  const url = new URL(href, "https://payments.google.com").href;
  const res = await context.request.get(url, { timeout: 60_000 });
  if (!res.ok()) throw new Error(`downloading ${label} → HTTP ${res.status()}`);

  const body = await res.body();
  if (body.subarray(0, 4).toString() !== "%PDF")
    throw new Error(`${label} came back as ${res.headers()["content-type"] ?? "something"}, not a PDF`);

  const file = path.join(OUT, `${label}.pdf`);
  await Bun.write(file, body);
  return file;
}

/**
 * Which facture belongs to the charge we are looking for?
 *
 * Each period is a collapsing card whose header subtitle reads "Solde de clôture : <x> €".
 * Only the most recent card is expanded, so reading the rendered text finds only the
 * newest invoice — the July one was invisible that way. This walks the DOM instead, and
 * picks the document out of the "Facture PDF" group specifically: the neighbouring
 * "Relevé" group is a statement, not an invoice.
 *
 * Returns null when the period has no facture at all — the current, unbilled period is
 * exactly that case, and it must fail rather than fall back to another month.
 */
async function factureFor(timeline: Frame, amount: VendorEntry["amount"]): Promise<string | null> {
  const shown = String(amount).replace(".", ",");
  return timeline.evaluate((wanted: string) => {
    const flat = (t: string | null | undefined): string => (t || "").replace(/[\s  ]/g, "");
    for (const card of document.querySelectorAll(".b3id-collapsing-card")) {
      const subtitle = card.querySelector(".b3-card-header-subtitle");
      if (!flat(subtitle?.textContent).includes(`Soldedeclôture:${wanted}€`)) continue;

      const group = [...card.querySelectorAll(".b3id-document-zippy-group")].find((g) =>
        /Facture/i.test(g.querySelector(".b3id-document-zippy-group-header")?.textContent ?? ""),
      );
      return /GCFRD\w+/.exec(group?.textContent ?? "")?.[0] ?? null;
    }
    return null;
  }, shown);
}

/** A collapsed card's rows cannot be clicked, so open it and wait for it to actually open. */
async function expandCardFor(timeline: Frame, label: string): Promise<boolean> {
  for (let i = 0; i < 12; i++) {
    const open = await timeline.evaluate((wanted: string) => {
      const card = [...document.querySelectorAll(".b3id-collapsing-card")].find((c) =>
        (c.textContent ?? "").includes(wanted),
      );
      if (!card) return false;
      if (card.classList.contains("expanded")) return true;
      (card.querySelector(".b3id-card-header, .b3-card-header") as HTMLElement | null)?.click();
      return false;
    }, label);
    if (open) return true;
    // The original waited 500ms twice per attempt (a defensive `waitForTimeout?.()` plus a
    // sleep). Kept at a full second: this Google card animates open slowly and a shorter
    // wait is what made the July invoice look absent.
    await Bun.sleep(1000);
  }
  return false;
}

/**
 * A threshold debit's "Reçu du paiement". Its row is a link that opens the receipt in a new
 * tab — an HTML page, not a PDF (fetching the URL returns text/html), so it is printed.
 * `page.pdf()` exists only in headless Chrome, which is how every run opens the browser.
 */
async function receipt(context: BrowserContext, page: Page, timeline: Frame, entry: VendorEntry): Promise<string> {
  const ref = entry.ref!;
  const opened = context.waitForEvent("page", { timeout: 30_000 });
  await timeline.locator("a", { hasText: ref }).first().click({ timeout: 20_000 });
  const tab = await opened;
  try {
    await tab.waitForLoadState("networkidle", { timeout: 25_000 }).catch(() => {});
    for (let i = 0; i < 15 && !(await innerText(tab)).includes(ref); i++) await page.waitForTimeout(1000);
    if (!/Reçu du paiement/i.test(await innerText(tab))) throw new Error(`payment ${ref} did not open a receipt`);
    const file = path.join(OUT, `gcp-receipt-${entry.date ?? "undated"}-${Number(entry.amount).toFixed(2)}.pdf`);
    await tab.pdf({ path: file, format: "A4", printBackground: true }).catch((e: unknown) => {
      throw new Error(`could not print the receipt for ${ref} (headed browser?): ${e instanceof Error ? e.message : e}`);
    });
    return file;
  } finally {
    await tab.close().catch(() => {});
  }
}
