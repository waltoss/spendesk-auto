import { chromium } from "playwright";
const ACC = process.argv[2] || "012512-2A6C67-A63A08";
const ORG = process.argv[3] || "134204199381";
const q = `?organizationId=${ORG}`;
const CANDIDATES = [
  `https://console.cloud.google.com/billing/${ACC}/documents${q}`,
  `https://console.cloud.google.com/billing/${ACC}/payments/documents${q}`,
  `https://console.cloud.google.com/billing/${ACC}/invoices${q}`,
  `https://console.cloud.google.com/billing/${ACC}/transactions${q}`,
];
const ctx = await chromium.launchPersistentContext(process.cwd() + "/.browser-data", {
  channel: "chrome", chromiumSandbox: true, headless: true, acceptDownloads: true,
  viewport: { width: 1600, height: 1000 },
  ignoreDefaultArgs: ["--disable-extensions", "--enable-automation"],
});
const page = ctx.pages()[0] || await ctx.newPage();
for (const url of CANDIDATES) {
  console.log("\n" + "=".repeat(86));
  console.log("TRY " + url.replace(q, ""));
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForLoadState("networkidle", { timeout: 25_000 }).catch(() => {});
    await page.waitForTimeout(7000);                       // Angular renders after networkidle
    if (/accounts\.google\.com/.test(page.url())) { console.log("  -> bounced to login"); continue; }
    console.log("  final: " + page.url().split("?")[0]);
    console.log("  title: " + (await page.title()));
    const txt = ((await page.textContent("body").catch(() => "")) || "").replace(/\s+/g, " ");
    console.log("  text : " + txt.slice(0, 340));
    const rows = await page.$$eval("tr", trs =>
      trs.map(t => (t.textContent || "").replace(/\s+/g, " ").trim()).filter(t => t.length > 12));
    if (rows.length) { console.log(`  ${rows.length} table row(s):`); rows.slice(0, 10).forEach(r => console.log("    " + r.slice(0, 140))); }
    const btns = await page.$$eval("button,[role=button],a[download]", bs =>
      [...new Set(bs.map(b => (b.getAttribute("aria-label") || b.textContent || "").replace(/\s+/g," ").trim()).filter(Boolean))]);
    console.log("  buttons: " + JSON.stringify(btns.slice(0, 14)));
  } catch (e) { console.log("  ERROR " + e.message.split("\n")[0]); }
}
await ctx.close();
