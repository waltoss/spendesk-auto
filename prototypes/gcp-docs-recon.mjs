import { chromium } from "playwright";
const SD = "/private/tmp/claude-501/-Users-waltoss-Code-Theodo-Playground-cursor-billing/1e01cfa3-edc5-4d5f-a2cd-ca3e4d603aea/scratchpad";
const ctx = await chromium.launchPersistentContext(process.cwd() + "/.browser-data", {
  channel: "chrome", chromiumSandbox: true, headless: process.argv.includes("--headless"),
  acceptDownloads: true, viewport: { width: 1600, height: 1050 },
  ignoreDefaultArgs: ["--disable-extensions", "--enable-automation"],
});
const page = ctx.pages()[0] || (await ctx.newPage());
const it = t => t.evaluate(() => document.body?.innerText || "").catch(() => "");
await page.goto("https://payments.google.com/gp/w/u/0/home/subscriptionsandservices", { waitUntil: "domcontentloaded", timeout: 60_000 });
for (let i = 0; i < 20; i++) { if (/Google Cloud/i.test(await it(page))) break; await page.waitForTimeout(1000); }
await page.getByRole("button", { name: /^Gérer$/ }).first().click({ timeout: 20_000 });
await page.waitForURL(/accountdetail/, { timeout: 30_000 }).catch(() => {});
await page.waitForTimeout(8000);
let f = page.frames().find(x => /embedded_landing_page/.test(x.url()));

console.log("clicking 'Afficher les transactions et les documents' ...");
await f.getByText(/Afficher les transactions/i).first().click({ timeout: 20_000 }).catch(e => console.log("  ", e.message.split("\n")[0]));
await page.waitForTimeout(9000);
console.log("main url:", page.url().slice(0, 120));
for (const fr of page.frames()) {
  const u = fr.url(); if (!u || u === "about:blank" || /RotateCookies|auth_warmup/.test(u)) continue;
  const t = (await it(fr)).replace(/\s+/g, " ");
  console.log(`\n[${fr === page.mainFrame() ? "main" : "iframe"}] ${u.split("?")[0].slice(0,70)} len=${t.length}`);
  if (t.length > 60) console.log("   " + t.slice(0, 700));
}
const surf = page.frames().find(async fr => /€/.test(await it(fr))) || page.mainFrame();
for (const fr of page.frames()) {
  const t = await it(fr);
  if (!/€|Relevé|GCFRD/i.test(t)) continue;
  const links = await fr.$$eval("a,button,[role=button],[jsaction]", els =>
    [...new Set(els.map(e => ((e.getAttribute("aria-label")||e.innerText||"")+"").replace(/\s+/g," ").trim()).filter(x=>x&&x.length<50))]);
  console.log(`\ncontrols on ${fr.url().split("?")[0].slice(0,60)}:`);
  console.log("  " + JSON.stringify(links.slice(0, 25)));
}
await page.screenshot({ path: `${SD}/docs-page.png`, fullPage: true });
console.log(`\nscreenshot ${SD}/docs-page.png`);
await ctx.close();
