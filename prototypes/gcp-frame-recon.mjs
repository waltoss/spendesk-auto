import { chromium } from "playwright";
const SD = "/private/tmp/claude-501/-Users-waltoss-Code-Theodo-Playground-cursor-billing/1e01cfa3-edc5-4d5f-a2cd-ca3e4d603aea/scratchpad";
const ctx = await chromium.launchPersistentContext(process.cwd() + "/.browser-data", {
  channel: "chrome", chromiumSandbox: true, headless: process.argv.includes("--headless"),
  acceptDownloads: true, viewport: { width: 1500, height: 1050 },
  ignoreDefaultArgs: ["--disable-extensions", "--enable-automation"],
});
const page = ctx.pages()[0] || (await ctx.newPage());
await page.goto("https://payments.google.com/gp/w/u/0/home/documentcenter", { waitUntil: "domcontentloaded", timeout: 60_000 });

let frame = null;
for (let i = 0; i < 40 && !frame; i++) {
  frame = page.frames().find(f => f !== page.mainFrame() && /payments\/u\/\d+\/documentcenter/.test(f.url())) || null;
  if (!frame) await page.waitForTimeout(750);
}
console.log("iframe:", frame ? frame.url().split("?")[0] : "NOT FOUND");
if (frame) {
  // wait for real content rather than a fixed sleep
  for (let i = 0; i < 40; i++) {
    const t = await frame.evaluate(() => document.body?.innerText || "").catch(() => "");
    if (/€|\d{4}/.test(t) && t.trim().length > 80) break;
    await page.waitForTimeout(1000);
  }
  const text = await frame.evaluate(() => document.body?.innerText || "").catch(() => "");
  console.log("\n--- iframe innerText ---\n" + text.slice(0, 1400));
  for (const sel of ["tr", '[role="row"]', ".b3-line-item", "[class*=line-item]", "[class*=row]", "li"]) {
    const rows = await frame.$$eval(sel, els => els.map(e => (e.innerText || "").replace(/\s+/g," ").trim()).filter(t => t.length > 8)).catch(() => []);
    if (rows.length) { console.log(`\nselector "${sel}" -> ${rows.length} rows`); rows.slice(0,10).forEach(r => console.log("   " + r.slice(0,140))); break; }
  }
  const clickable = await frame.$$eval("button,[role=button],a,[class*=download]", els =>
    [...new Set(els.map(e => (e.getAttribute("aria-label") || e.innerText || "").replace(/\s+/g," ").trim()).filter(Boolean))]).catch(() => []);
  console.log("\nclickable:", JSON.stringify(clickable.slice(0, 20)));
}
await page.screenshot({ path: `${SD}/doccenter2.png`, fullPage: true });
console.log(`\nscreenshot: ${SD}/doccenter2.png`);
await ctx.close();
