// Invoice retrieval. 5% of the problem, and the only place a failure can be silent —
// which is why nothing leaves this module unverified.
//
// 14 of the 25 files the previous version produced are ~2.9KB tryPrintPageAsPdf() output
// with zero extractable text: a page that never rendered, saved and reported as success
// (DESIGN §10). So every PDF is read back with pdftotext and must state the amount
// Spendesk charged, or it is deleted and the payable is escalated.
import { $ } from "bun";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { BrowserContext, Page } from "playwright";
import { err, ok, type InvoiceTarget, type Result, type VendorEntry, type VendorName } from "../types.ts";
import * as anthropic from "./anthropic.ts";
import * as cursor from "./cursor.ts";
import * as gcp from "./gcp.ts";

export const OUT = path.resolve(process.cwd(), "invoices");

export interface VendorAdapter {
  loggedOut(page: Page): Promise<boolean>;
  list(page: Page): Promise<VendorEntry[]>;
  download(context: BrowserContext, page: Page, entry: VendorEntry): Promise<string>;
  /** Optional extra assertion a vendor can make about its own documents. */
  verify?(text: string, entry: VendorEntry): string | null;
}

const ADAPTERS: Record<VendorName, VendorAdapter> = { anthropic, cursor, gcp };

export const VENDORS = Object.keys(ADAPTERS) as VendorName[];

export function isVendor(name: string): name is VendorName {
  return Object.hasOwn(ADAPTERS, name);
}

export const hasAdapter = (name: string | null | undefined): boolean => Boolean(name) && isVendor(name as string);

export const adapterFor = (name: VendorName): VendorAdapter => ADAPTERS[name];

/**
 * Did we get bounced to an identity provider?
 *
 * Matching page text for "sign in" is not enough: Cursor's logout lands on
 * authenticator.cursor.sh behind a Cloudflare interstitial that says "Performing security
 * verification" and nothing else, so a text check reported "signed in, 0 invoices" — a
 * silent failure of exactly the kind this module exists to prevent. The host is the fact.
 */
export function redirectedAway(page: Page, ownHost: string): boolean {
  let host: string;
  try {
    host = new URL(page.url()).host;
  } catch {
    return true;
  }
  return !(host === ownHost || host.endsWith(`.${ownHost}`));
}

/**
 * `pdftotext` via Bun's shell. `.nothrow()` covers a non-zero exit (an unreadable file);
 * the try/catch covers poppler not being installed at all. Both mean "reject", because a
 * PDF we cannot read is a PDF we must not attach.
 */
async function pdfText(file: string): Promise<string> {
  try {
    const result = await $`pdftotext -q ${file} -`.quiet().nothrow();
    return result.exitCode === 0 ? result.stdout.toString() : "";
  } catch {
    return "";
  }
}

export interface PdfInfo {
  bytes: number;
  isPdf: boolean;
  words: number;
  text: string;
  readable: boolean;
}

/** A PDF we cannot read is a PDF we must not attach. */
export async function inspectPdf(file: string): Promise<PdfInfo> {
  const handle = Bun.file(file);
  const bytes = handle.size;
  const head = new Uint8Array(await handle.slice(0, 5).arrayBuffer());
  const isPdf = new TextDecoder().decode(head.subarray(0, 4)) === "%PDF";

  const text = isPdf ? await pdfText(file) : "";
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return { bytes, isPdf, words, text, readable: isPdf && words > 20 };
}

/** Does this PDF actually state the amount Spendesk charged? */
export function statesAmount(text: string, amount: number): boolean {
  const exact = amount.toFixed(2);
  const forms = [exact, exact.replace(".", ","), exact.replace(/\B(?=(\d{3})+(?!\d))/g, ",")];
  const flat = text.replace(/[\s  ]/g, "");
  return forms.some((f) => flat.includes(f.replace(/\s/g, "")));
}

/** How far a vendor's own date may sit from Spendesk's: settlement and time zones shift it. */
const DATE_SLACK_DAYS = 3;

/**
 * Which listed entries could be this charge? Amount and currency first. Only if that
 * leaves a tie are dated entries narrowed to the charge's own day: GCP threshold debits are
 * the same 500 € every time, and amount alone would refuse all of them. Entries dated by
 * period rather than by day ("1–30 sept. 2026") drop out of a tie, never into one.
 */
export function candidatesFor(entries: VendorEntry[], target: InvoiceTarget): VendorEntry[] {
  const byAmount = entries.filter(
    (e) => Math.abs(Number(e.amount) - target.amount) < 0.005 && (!e.currency || e.currency === target.currency),
  );
  if (byAmount.length < 2 || !target.paidAt) return byAmount;
  const day = new Date(`${target.paidAt}T00:00:00Z`).getTime();
  return byAmount.filter(
    (e) =>
      /^\d{4}-\d{2}-\d{2}$/.test(e.date ?? "") &&
      Math.abs(new Date(`${e.date}T00:00:00Z`).getTime() - day) <= DATE_SLACK_DAYS * 864e5,
  );
}

const discard = (file: string): Promise<void> => Bun.file(file).unlink().catch(() => {});

export type InvoiceResult = Result<{ file: string; verified: true }>;

/**
 * Fetch the invoice for one specific charge and prove it is the right one.
 * Returns the file or the reason — never a guess.
 */
export async function fetchInvoice(
  context: BrowserContext,
  vendor: VendorName,
  payment: InvoiceTarget,
  { entries: known = null }: { entries?: VendorEntry[] | null } = {},
): Promise<InvoiceResult> {
  const adapter = ADAPTERS[vendor];
  await mkdir(OUT, { recursive: true });

  const page = await context.newPage();
  try {
    if (!known && (await adapter.loggedOut(page)))
      return err(`not signed in to ${vendor} — run: bun run reauth`);

    // Enumerating GCP means several full page loads per billing account, and hammering
    // Google is what rate-limited this account once. Reuse a listing when we have one.
    const entries = known ?? (await adapter.list(page));
    // An empty listing is never a legitimate answer to "fetch this specific invoice" —
    // it means the page did not render what we expected, so say so rather than reporting
    // "0 matches" as if we had looked.
    if (!entries.length) return err(`${vendor} listed no invoices at all — the page did not render as expected`);

    const targets = candidatesFor(entries, payment);
    const target = targets[0];
    if (targets.length !== 1 || !target)
      return err(
        `${targets.length} invoices match ${payment.amount.toFixed(2)} ${payment.currency} at ${vendor} — refusing to guess`,
      );

    const file = await adapter.download(context, page, target);
    const info = await inspectPdf(file);
    if (!info.readable) {
      await discard(file);
      return err(`the downloaded PDF has no extractable text (${info.bytes} bytes) — discarded`);
    }
    if (!statesAmount(info.text, payment.amount)) {
      await discard(file);
      return err(`the downloaded PDF does not mention ${payment.amount.toFixed(2)} ${payment.currency} — discarded`);
    }
    // A vendor may know something more specific about its own documents than "the amount
    // appears" — GCP invoices name their billing account, which catches a cross-account mixup.
    const complaint = adapter.verify?.(info.text, target);
    if (complaint) {
      await discard(file);
      return err(`${complaint} — discarded`);
    }
    return ok({ file, verified: true });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  } finally {
    await page.close().catch(() => {});
  }
}

/** Which GCP billing account produced a given charge? Matched by amount (then day), never assumed. */
export async function resolveGcpAccount(context: BrowserContext, payment: InvoiceTarget): Promise<string | null> {
  const page = await context.newPage();
  try {
    if (await gcp.loggedOut(page)) throw new Error("not signed in to Google");
    const entries = await gcp.list(page);
    const hits = candidatesFor(entries, payment);
    const hit = hits[0];
    if (hits.length !== 1 || !hit) return null;
    return hit.account ?? null;
  } finally {
    await page.close().catch(() => {});
  }
}
