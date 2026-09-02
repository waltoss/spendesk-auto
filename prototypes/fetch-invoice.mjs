// Targeted invoice retrieval: given what Spendesk says was charged, find THAT invoice
// and prove the PDF matches before it is ever attached.
//
//   node prototypes/fetch-invoice.mjs cursor
//   node prototypes/fetch-invoice.mjs gcp
//   node prototypes/fetch-invoice.mjs cursor --amount 20 --currency USD
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chromium } from "playwright";

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();
const PROFILE = path.resolve(ROOT, ".browser-data");
const OUT = path.resolve(ROOT, "invoices");

const VENDOR = process.argv[2] || "cursor";
const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : null; };
const WANT_AMOUNT = arg("amount");
const WANT_CURRENCY = arg("currency") || "USD";
const HEADED = !process.argv.includes("--headless");

const innerText = (target) =>
  target.evaluate(() => document.body?.innerText || "").catch(() => "");

const VENDORS = {
  cursor: { url: "https://cursor.com/dashboard?tab=billing", loggedOut: /sign in|log in|continue with google/i },
  gcp: { url: "https://console.cloud.google.com/billing", loggedOut: /sign in|choose an account/i },
};

// ---------------------------------------------------------------- pdf verify

async function pdfText(file) {
  try {
    const { stdout } = await execFileAsync("pdftotext", ["-q", file, "-"]);
    return stdout;
  } catch { return ""; }
}

// A PDF we cannot read is a PDF we must not attach.
async function inspectPdf(file) {
  const bytes = (await fsp.stat(file)).size;
  const head = Buffer.alloc(5);
  const fd = await fsp.open(file, "r"); await fd.read(head, 0, 5, 0); await fd.close();
  const isPdf = head.toString("utf8", 0, 4) === "%PDF";
  const text = isPdf ? await pdfText(file) : "";
  const words = text.trim().split(/\s+/).filter(Boolean).length;

  const amount = /(?:US\$|\$|€|EUR)\s?([\d,]+\.\d{2})/.exec(text)?.[1] ?? null;
  const number = /Invoice number\s+(\S+)/i.exec(text)?.[1] ?? null;
  const date = /Date of issue\s+(.+)/i.exec(text)?.[1]?.trim() ?? null;

  return { bytes, isPdf, words, amount, number, date, readable: isPdf && words > 20 };
}

// ------------------------------------------------------------------ adapters

const ADAPTERS = {
  // Cursor bills through Stripe. The dashboard lists rows with date + amount + a link to
  // the Stripe hosted invoice; the PDF is only reachable by clicking "Download invoice"
  // on that page (the hosted page is a 745-byte JS shim, so plain HTTP sees nothing).
  cursor: {
    url: "https://cursor.com/dashboard?tab=billing",
    loggedOut: /sign in|log in|continue with google/i,

    async list(page) {
      const rows = await page.$$eval('a[href*="invoice.stripe.com"]', (as) =>
        as.map((a) => ({
          url: a.href,
          row: (a.closest("tr,li,div[class*=row],div") || a.parentElement)?.textContent
            ?.replace(/\s+/g, " ").trim().slice(0, 160) || "",
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
    },

    async download(context, entry) {
      const page = await context.newPage();
      try {
        await page.goto(entry.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
        await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
        const btn = page.getByRole("button", { name: /^Download invoice$/i }).first();
        await btn.waitFor({ state: "visible", timeout: 20_000 });
        const [dl] = await Promise.all([
          page.waitForEvent("download", { timeout: 30_000 }),
          btn.click(),
        ]);
        const name = (dl.suggestedFilename() || `cursor-${Date.now()}.pdf`).replace(/[/\\]/g, "_");
        const file = path.join(OUT, name);
        await dl.saveAs(file);
        return file;
      } finally {
        await page.close().catch(() => {});
      }
    },
  },

  // GCP, entirely within payments.google.com — no Cloud Console, so no rate-limit risk.
  //   /home/subscriptionsandservices  -> one "Gérer" link per billing account, carrying ebaid=
  //   /home/accountdetail?ebaid=...   -> transactions, each with a download menu
  //   the menu offers the facture (GCFRD….pdf) and a Relevé (statement); we want the facture.
  gcp: {
    url: () => "https://payments.google.com/gp/w/u/0/home/subscriptionsandservices",
    loggedOut: /sign in|choose an account/i,

    // "Gérer" is a <button> with a jsaction — the ebaid URL is minted on click, so we
    // click each one and record where it lands.
    async accounts(page) {
      const HOME = "https://payments.google.com/gp/w/u/0/home/subscriptionsandservices";
      const settle = async () => {
        await page.waitForLoadState("networkidle", { timeout: 25_000 }).catch(() => {});
        for (let i = 0; i < 20; i++) {
          if (/Google Cloud/i.test(await page.evaluate(() => document.body?.innerText || ""))) return;
          await page.waitForTimeout(1000);
        }
      };
      await settle();
      const n = await page.getByRole("button", { name: /^Gérer$/ }).count();
      const out = [];
      for (let i = 0; i < n; i++) {
        await page.goto(HOME, { waitUntil: "domcontentloaded", timeout: 60_000 });
        await settle();
        await page.getByRole("button", { name: /^Gérer$/ }).nth(i).click({ timeout: 20_000 }).catch(() => {});
        await page.waitForURL(/accountdetail/, { timeout: 30_000 }).catch(() => {});
        await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
        await page.waitForTimeout(3000);
        // the id renders inside the embedded_landing_page iframe, not the main document
        let account = null;
        for (let k = 0; k < 25; k++) {
          const f = page.frames().find((f) => /embedded_landing_page/.test(f.url()));
          if (f) {
            const t = (await innerText(f)).replace(/\s+/g, " ");
            const m = /([0-9A-F]{6}-[0-9A-F]{6}-[0-9A-F]{6})/.exec(t);
            if (m) { account = m[1]; break; }
          }
          await page.waitForTimeout(1000);
        }
        if (page.url().includes("accountdetail")) out.push({ account, href: page.url() });
      }
      return out;
    },

    // The detail page renders inside a payments/u/0/embedded_landing_page iframe, and the
    // Transactions block is two parallel columns (dates, amounts) plus one download icon per
    // row that actually has a document — the current, unbilled period has none.
    async frame(page) {
      for (let i = 0; i < 30; i++) {
        const f = page.frames().find((f) => /embedded_landing_page/.test(f.url()));
        if (f && /€/.test(await innerText(f))) return f;
        await page.waitForTimeout(1000);
      }
      throw new Error("account detail iframe never rendered");
    },

    async list(page) {
      const accounts = await ADAPTERS.gcp.accounts(page);
      console.log(`   ${accounts.length} billing account(s): ${accounts.map((a) => a.account || "?").join(", ")}`);
      const wanted = arg("account");
      const out = [];

      for (const acc of accounts) {
        if (wanted && acc.account !== wanted) continue;
        if (page.url() !== acc.href) {
          await page.goto(acc.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
          await page.waitForTimeout(3000);
        }
        const frame = await ADAPTERS.gcp.frame(page);
        const { dates, amounts, icons } = await frame.evaluate(() => {
          const txt = (e) => (e.innerText || "").replace(/\s+/g, " ").trim();
          // scope to the Transactions card, else the balance and payment-threshold
          // figures get mixed in with the per-period amounts
          const card = [...document.querySelectorAll("div,section")]
            .filter((c) => /(^|\s)Transactions(\s|$)/.test(txt(c)) && /\d{1,2}\s*[–-]\s*\d{1,2}/.test(txt(c)))
            .sort((a, b) => txt(a).length - txt(b).length)[0];
          if (!card) return { dates: [], amounts: [], icons: 0 };
          const leaves = [...card.querySelectorAll("*")].filter((e) => e.children.length === 0);
          return {
            dates: leaves.map(txt).filter((t) => /^\d{1,2}\s*[–-]\s*\d{1,2}\s+\S+\s+\d{4}$/.test(t)),
            amounts: leaves.map(txt).filter((t) => /^[\d  .,]+\s?€$/.test(t)),
            icons: [...card.querySelectorAll("[jsaction]")].filter((e) => !txt(e)).length,
          };
        });
        console.log(`   ${acc.account}: ${dates.length} period(s), ${amounts.length} amount(s), ${icons} download icon(s)`);
        dates.forEach((date, k) =>
          out.push({
            account: acc.account,
            href: acc.href,
            date,
            amount: (amounts[k] || "").replace(/[\s €]/g, "").replace(/\.(?=\d{3}\b)/g, "").replace(",", "."),
            currency: "EUR",
            rowIndex: k,
            rowCount: dates.length,
          }),
        );
      }
      return out;
    },

    async download(context, entry, page) {
      if (page.url() !== entry.href) {
        await page.goto(entry.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
        await page.waitForTimeout(3000);
      }
      // The summary card has no download control. "Afficher les transactions et les documents"
      // opens a timelineview iframe where each period lists its documents as real links.
      const summary = await ADAPTERS.gcp.frame(page);
      await summary.getByText(/Afficher les transactions/i).first().click({ timeout: 20_000 });

      let timeline = null;
      for (let i = 0; i < 30 && !timeline; i++) {
        timeline = page.frames().find((f) => /timelineview/.test(f.url())) || null;
        if (timeline && !/Documents/i.test(await innerText(timeline))) timeline = null;
        if (!timeline) await page.waitForTimeout(1000);
      }
      if (!timeline) throw new Error("timelineview never rendered — would escalate");

      // Pick the facture belonging to the period whose closing balance is our amount.
      const shown = entry.amount.replace(".", ",");
      const label = await timeline.evaluate(({ shown }) => {
        const text = (document.body.innerText || "").replace(/\r/g, "");
        // each period block ends with "Solde de clôture : <amount> €"
        const blocks = text.split(/(?=\d{1,2}[–-]\d{1,2}\s+\S+\s+\d{4}\n)/);
        const hit = blocks.find(
          (b) => b.replace(/[\s ]/g, "").includes(`Soldedeclôture:${shown}€`) && /GCFRD\w+/.test(b),
        );
        return hit ? /GCFRD\w+[^\n)]*\)?/.exec(hit)?.[0]?.trim() ?? null : null;
      }, { shown });

      if (!label) throw new Error(`no facture found for ${shown} € — would escalate, never guess`);
      console.log(`   document: ${label}`);

      // Clicking may fire a download, open a popup, or navigate to the PDF — watch for all three.
      const pdfUrls = [];
      const onResponse = (r) => {
        const ct = (r.headers()["content-type"] || "").toLowerCase();
        if (ct.includes("pdf") || /\.pdf(\?|$)/i.test(r.url())) pdfUrls.push(r.url());
      };
      page.on("response", onResponse);
      const popups = [];
      const onPopup = (p) => popups.push(p);
      context.on("page", onPopup);

      // getByText lands on a container; the facture is a link/button — target it by role,
      // and fall back to the nearest <a> ancestor.
      const id = label.split(" ")[0];
      const byRole = timeline.getByRole("link", { name: new RegExp(id) }).first();
      const byBtn = timeline.getByRole("button", { name: new RegExp(id) }).first();
      const byAnchor = timeline.locator(`xpath=//a[contains(., "${id}")]`).first();
      let target = null;
      for (const [name, loc] of [["link", byRole], ["button", byBtn], ["anchor", byAnchor]]) {
        if (await loc.isVisible().catch(() => false)) { console.log(`   clicking via ${name}`); target = loc; break; }
      }
      if (!target) {
        const dump = await timeline.evaluate((id) =>
          [...document.querySelectorAll("*")]
            .filter((e) => (e.innerText || "").includes(id) && e.children.length <= 1)
            .map((e) => `${e.tagName}[role=${e.getAttribute("role") || "-"}] jsaction=${!!e.getAttribute("jsaction")} cls=${(e.className || "").toString().slice(0, 40)}`)
            .slice(0, 6), id);
        console.log("   candidates:", JSON.stringify(dump));
        throw new Error(`could not locate a clickable for ${id}`);
      }

      let dl = null;
      const waitDownload = page.waitForEvent("download", { timeout: 25_000 }).catch(() => null);
      await target.click({ timeout: 20_000 });
      dl = await waitDownload;
      if (!dl) await page.waitForTimeout(6000);

      page.off("response", onResponse);
      context.off("page", onPopup);

      const file = path.join(OUT, `${label.split(" ")[0]}.pdf`);
      if (dl) {
        await dl.saveAs(file);
        return file;
      }
      for (const p of popups) {
        const u = p.url();
        await p.close().catch(() => {});
        if (/pdf|get_document/i.test(u)) pdfUrls.push(u);
      }
      console.log(`   no download event; pdf candidates: ${pdfUrls.length}`);
      for (const u of [...new Set(pdfUrls)]) {
        const res = await context.request.get(u, { timeout: 45_000 }).catch(() => null);
        if (!res || !res.ok()) continue;
        const body = await res.body();
        if (body.subarray(0, 4).toString() !== "%PDF") continue;
        await fsp.writeFile(file, body);
        return file;
      }
      throw new Error("clicked the facture but no PDF appeared — would escalate");
    },
  },
};

// ----------------------------------------------------------------------- main

async function main() {
  const cfg = ADAPTERS[VENDOR];
  const ACC = arg("account") || "012512-2A6C67-A63A08";
  const ORG = arg("org") || "134204199381";
  if (!cfg) throw new Error(`unknown vendor "${VENDOR}" (have: ${Object.keys(ADAPTERS).join(", ")})`);
  await fsp.mkdir(OUT, { recursive: true });

  const context = await chromium.launchPersistentContext(PROFILE, {
    channel: "chrome",
    chromiumSandbox: true,
    headless: !HEADED,
    acceptDownloads: true,
    viewport: { width: 1500, height: 950 },
    ignoreDefaultArgs: ["--disable-extensions", "--enable-automation"],
  });

  try {
    const page = context.pages()[0] || (await context.newPage());
    const startUrl = typeof cfg.url === "function" ? cfg.url(ACC, ORG) : cfg.url;
    console.log(`→ ${startUrl}`);
    await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
    console.log(`landed: ${page.url()}`);

    // Redirect to an identity provider is a far more reliable signal than page text.
    const loggedOut = async () => {
      const u = page.url();
      if (/accounts\.google\.com|\/auth\/login|\/signin/i.test(u)) return true;
      const b = (await page.textContent("body").catch(() => "")) || "";
      return cfg.loggedOut.test(b.slice(0, 4000));
    };

    if (await loggedOut()) {
      if (!HEADED) { console.log("\n⚠️  logged out — rerun without --headless to sign in"); return; }
      console.log(`\n⚠️  logged out. Sign in in the window; waiting up to 5 min...`);
      const deadline = Date.now() + 300_000;
      while (Date.now() < deadline) {
        if (page.isClosed()) return;
        if (!(await loggedOut())) { console.log("signed in ✓"); break; }
        await page.waitForTimeout(3000);
      }
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    }

    const entries = await cfg.list(page);
    console.log(`\nfound ${entries.length} invoice(s):`);
    for (const e of entries)
      console.log(`   ${(e.date ?? "?").padEnd(16)} ${(e.amount ?? "?").padStart(9)} ${e.currency ?? ""}  ${e.status ?? ""}`);

    const targets = WANT_AMOUNT
      ? entries.filter((e) => e.amount === Number(WANT_AMOUNT).toFixed(2) && (!e.currency || e.currency === WANT_CURRENCY))
      : entries.slice(0, 1);

    if (WANT_AMOUNT && targets.length !== 1) {
      console.log(`\ntarget ${WANT_CURRENCY} ${WANT_AMOUNT}: ${targets.length} candidates — would escalate, never guess.`);
      return;
    }

    for (const t of targets) {
      console.log(`\ndownloading ${t.date} ${t.amount} ${t.currency} ...`);
      const file = await cfg.download(context, t, page);
      const info = await inspectPdf(file);
      console.log(`   ${path.basename(file)}  ${info.bytes}b  words=${info.words}  ` +
                  `amount=${info.amount ?? "?"}  no=${info.number ?? "?"}  ${info.date ?? ""}`);

      const expected = t.amount;
      const ok = info.readable && expected && info.amount === expected;
      console.log(`   verdict: ${ok ? "VERIFIED ✓ safe to attach" : "REJECTED ✗ — " +
        (!info.readable ? "no extractable text" : `pdf says ${info.amount}, expected ${expected}`)}`);
      if (!ok) { await fsp.unlink(file).catch(() => {}); console.log("   (deleted — never attach an unverified PDF)"); }
    }
  } finally {
    await context.close().catch(() => {});
  }
}

main().catch((e) => { console.error(`FAILED: ${e.message}`); process.exit(1); });
