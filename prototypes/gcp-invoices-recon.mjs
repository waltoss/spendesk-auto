import { chromium } from "playwright";
const ACC = process.argv[2] || "012512-2A6C67-A63A08";
const ctx = await chromium.launchPersistentContext(process.cwd() + "/.browser-data", {
  channel: "chrome", chromiumSandbox: true, headless: true, acceptDownloads: true,
  viewport: { width: 1700, height: 1100 },
  ignoreDefaultArgs: ["--disable-extensions", "--enable-automation"],
});
const page = ctx.pages()[0] || await ctx.newPage();
await page.goto(`https://console.cloud.google.com/billing/${ACC}/invoices`, { waitUntil: "domcontentloaded", timeout: 60_000 });
await page.waitForLoadState("networkidle", { timeout: 25_000 }).catch(() => {});

// the consent banner overlays the grid
for (const label of ["Understood", "Accept all", "J'ai compris"]) {
  const b = page.getByRole("button", { name: label }).first();
  if (await b.isVisible().catch(() => false)) { await b.click().catch(() => {}); console.log(`dismissed: ${label}`); break; }
}
await page.waitForTimeout(9000);

console.log("url  :", page.url().split("?")[0]);
const main = ((await page.locator("main").textContent().catch(() => null)) ||
              (await page.textContent("body").catch(() => "")) || "").replace(/\s+/g, " ");
console.log("main text (1200 chars):\n" + main.slice(0, 1200));

// invoice IDs and money look like this
console.log("\ndates found  :", [...new Set(main.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4}/g) || [])].slice(0, 8));
console.log("amounts found:", [...new Set(main.match(/€\s?[\d.,]+|[\d.,]+\s?€/g) || [])].slice(0, 10));
console.log("invoice ids  :", [...new Set(main.match(/\b\d{10,}\b/g) || [])].slice(0, 8));

for (const sel of ["tr", '[role="row"]', "cfc-table-row", ".mat-mdc-row", "mat-row", "li"]) {
  const rows = await page.$$eval(sel, els =>
    els.map(e => (e.textContent || "").replace(/\s+/g, " ").trim()).filter(t => t.length > 15)).catch(() => []);
  if (rows.length) { console.log(`\nselector "${sel}" -> ${rows.length} rows`); rows.slice(0, 8).forEach(r => console.log("   " + r.slice(0, 150))); break; }
}
const acts = await page.$$eval("button,[role=button],a", bs =>
  [...new Set(bs.map(b => (b.getAttribute("aria-label") || b.textContent || "").replace(/\s+/g," ").trim())
    .filter(t => /download|pdf|invoice|télécharg|facture|csv/i.test(t)))]);
console.log("\ndownload-ish controls:", JSON.stringify(acts.slice(0, 14)));
await page.screenshot({ path: "/private/tmp/claude-501/-Users-waltoss-Code-Theodo-Playground-cursor-billing/1e01cfa3-edc5-4d5f-a2cd-ca3e4d603aea/scratchpad/gcp-invoices.png", fullPage: false });
console.log("\nscreenshot saved");
await ctx.close();
