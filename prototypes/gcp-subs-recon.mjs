import { chromium } from "playwright";
const SD = "/private/tmp/claude-501/-Users-waltoss-Code-Theodo-Playground-cursor-billing/1e01cfa3-edc5-4d5f-a2cd-ca3e4d603aea/scratchpad";
const ctx = await chromium.launchPersistentContext(process.cwd() + "/.browser-data", {
  channel: "chrome", chromiumSandbox: true, headless: process.argv.includes("--headless"),
  acceptDownloads: true, viewport: { width: 1600, height: 1050 },
  ignoreDefaultArgs: ["--disable-extensions", "--enable-automation"],
});
const page = ctx.pages()[0] || (await ctx.newPage());
await page.goto("https://payments.google.com/gp/w/u/0/home/subscriptionsandservices", { waitUntil: "domcontentloaded", timeout: 60_000 });
await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
for (let i = 0; i < 25; i++) {
  const t = await page.evaluate(() => document.body?.innerText || "");
  if (/Google Cloud/i.test(t)) break;
  await page.waitForTimeout(1000);
}
const text = await page.evaluate(() => document.body?.innerText || "");
console.log("=== innerText ===\n" + text.slice(0, 900));

console.log("\n=== all anchors ===");
const as = await page.$$eval("a", els => els.map(a => ({ t:(a.innerText||"").replace(/\s+/g," ").trim().slice(0,32), h:a.getAttribute("href")||"", })).filter(x=>x.t||x.h));
[...new Map(as.map(a=>[a.t+a.h,a])).values()].slice(0,25).forEach(a=>console.log(`   "${a.t}" -> ${a.h.slice(0,110)}`));

console.log("\n=== buttons / clickables mentioning Gérer|Manage ===");
const bs = await page.$$eval('button,[role=button],[jsaction]', els =>
  els.map(b => ({ t:(b.innerText||"").replace(/\s+/g," ").trim().slice(0,32), tag:b.tagName, ja:(b.getAttribute("jsaction")||"").slice(0,40) }))
     .filter(x => /gérer|manage/i.test(x.t)));
bs.slice(0,10).forEach(b=>console.log(`   [${b.tag}] "${b.t}" jsaction=${b.ja}`));

console.log("\n=== does ebaid appear anywhere in the DOM? ===");
const html = await page.content();
const eb = [...new Set((html.match(/ebaid[=%3D"':\s]*([A-Za-z0-9_\-%+/]{20,})/g)||[]))].slice(0,5);
console.log("   ", eb.length ? eb.map(s=>s.slice(0,80)) : "none");
const accts = [...new Set(html.match(/[0-9A-F]{6}-[0-9A-F]{6}-[0-9A-F]{6}/g)||[])];
console.log("   account ids in DOM:", accts);

// what happens if we just click Gérer?
const g = page.getByText(/^Gérer$/).first();
if (await g.isVisible().catch(()=>false)) {
  console.log("\nclicking first 'Gérer' ...");
  await g.click().catch(e=>console.log("  ", e.message.split("\n")[0]));
  await page.waitForTimeout(6000);
  console.log("  url now:", page.url().slice(0,140));
}
await page.screenshot({ path: `${SD}/subs.png`, fullPage: true });
console.log(`\nscreenshot ${SD}/subs.png`);
await ctx.close();
