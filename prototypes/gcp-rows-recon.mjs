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
for (let i = 0; i < 20; i++) { if (/Google Cloud/i.test(await page.evaluate(() => document.body?.innerText || ""))) break; await page.waitForTimeout(1000); }
await page.getByRole("button", { name: /^Gérer$/ }).first().click({ timeout: 20_000 });
await page.waitForURL(/accountdetail/, { timeout: 30_000 }).catch(() => {});
await page.waitForTimeout(9000);

const f = page.frames().find(f => /embedded_landing_page/.test(f.url()));
console.log("iframe:", !!f);

// dump the Transactions block structurally
const rows = await f.evaluate(() => {
  const out = [];
  const isMoney = (s) => /\d[\d  .,]*\s?€/.test(s);
  document.querySelectorAll("*").forEach((el) => {
    if (el.children.length > 6) return;
    const t = (el.innerText || "").replace(/\s+/g, " ").trim();
    if (!t || t.length > 90) return;
    if (/\d{1,2}\s*[–-]\s*\d{1,2}\s+\S+\s+\d{4}/.test(t) && isMoney(t)) {
      out.push({ tag: el.tagName, cls: (el.className || "").toString().slice(0, 50), text: t,
                 btns: [...el.querySelectorAll('button,[role=button],[jsaction]')].map(b => (b.getAttribute("aria-label") || b.innerText || b.tagName).replace(/\s+/g," ").trim().slice(0, 30)) });
    }
  });
  return out.slice(0, 12);
});
console.log("\ncandidate rows:");
rows.forEach(r => console.log(`  [${r.tag}] "${r.text}"  buttons=${JSON.stringify(r.btns)}`));

// what clickable things live near the amounts?
const clickables = await f.evaluate(() => [...new Set(
  [...document.querySelectorAll('button,[role=button],[jsaction],svg,i')]
    .map(e => ((e.getAttribute("aria-label") || e.innerText || e.tagName) + "").replace(/\s+/g," ").trim())
    .filter(t => t && t.length < 40))].slice(0, 30));
console.log("\nclickables in iframe:", JSON.stringify(clickables));
await page.screenshot({ path: `${SD}/rows.png`, fullPage: true });
console.log(`\nscreenshot ${SD}/rows.png`);
await ctx.close();
