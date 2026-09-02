import { chromium } from "playwright";
const SD = "/private/tmp/claude-501/-Users-waltoss-Code-Theodo-Playground-cursor-billing/1e01cfa3-edc5-4d5f-a2cd-ca3e4d603aea/scratchpad";
const ctx = await chromium.launchPersistentContext(process.cwd() + "/.browser-data", {
  channel: "chrome", chromiumSandbox: true, headless: process.argv.includes("--headless"),
  acceptDownloads: true, viewport: { width: 1600, height: 1050 },
  ignoreDefaultArgs: ["--disable-extensions", "--enable-automation"],
});
const page = ctx.pages()[0] || (await ctx.newPage());
await page.goto("https://payments.google.com/gp/w/u/0/home/subscriptionsandservices", { waitUntil: "domcontentloaded", timeout: 60_000 });
await page.waitForLoadState("networkidle", { timeout: 25_000 }).catch(() => {});
for (let i = 0; i < 20; i++) {
  if (/Google Cloud/i.test(await page.evaluate(() => document.body?.innerText || ""))) break;
  await page.waitForTimeout(1000);
}
await page.getByRole("button", { name: /^Gérer$/ }).first().click({ timeout: 20_000 });
await page.waitForURL(/accountdetail/, { timeout: 30_000 }).catch(() => {});
await page.waitForLoadState("networkidle", { timeout: 25_000 }).catch(() => {});
await page.waitForTimeout(9000);
console.log("url:", page.url().slice(0, 120));

console.log("\nframes:");
for (const f of page.frames()) {
  if (!f.url() || f.url() === "about:blank") continue;
  const t = (await f.evaluate(() => document.body?.innerText || "").catch(() => "")).replace(/\s+/g, " ");
  console.log(`  ${f === page.mainFrame() ? "[main]" : "[iframe]"} ${f.url().split("?")[0].slice(0, 80)}  len=${t.length}`);
  if (t.length > 80) console.log("      " + t.slice(0, 420));
}

// find whichever surface has the money
const surfaces = page.frames();
for (const f of surfaces) {
  const t = (await f.evaluate(() => document.body?.innerText || "").catch(() => ""));
  if (!/€/.test(t)) continue;
  console.log("\n*** surface with € :", f.url().split("?")[0]);
  const rows = [...t.matchAll(/(\d{1,2}\s*[–-]\s*\d{1,2}\s+[A-Za-zéûà.]+\s+\d{4})[^\d]{0,20}([\d  .,]+)\s?€/gi)];
  console.log("  parsed rows:", rows.map(m => [m[1].trim(), m[2].trim()]));
  const dl = await f.$$eval('button,[role=button],[aria-label]', els =>
    [...new Set(els.map(e => (e.getAttribute("aria-label")||e.innerText||"").replace(/\s+/g," ").trim())
      .filter(x => /télécharg|download|pdf|relev/i.test(x)))]).catch(()=>[]);
  console.log("  download controls:", JSON.stringify(dl.slice(0,10)));
  break;
}
await page.screenshot({ path: `${SD}/accountdetail.png`, fullPage: true });
console.log(`\nscreenshot ${SD}/accountdetail.png`);
await ctx.close();
