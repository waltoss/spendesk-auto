import { chromium } from "playwright";
const SD = "/private/tmp/claude-501/-Users-waltoss-Code-Theodo-Playground-cursor-billing/1e01cfa3-edc5-4d5f-a2cd-ca3e4d603aea/scratchpad";
const ctx = await chromium.launchPersistentContext(process.cwd() + "/.browser-data", {
  channel: "chrome", chromiumSandbox: true, headless: process.argv.includes("--headless"),
  acceptDownloads: true, viewport: { width: 1600, height: 1050 },
  ignoreDefaultArgs: ["--disable-extensions", "--enable-automation"],
});
const page = ctx.pages()[0] || (await ctx.newPage());
await page.goto("https://payments.google.com/gp/w/u/0/home/subscriptionsandservices", { waitUntil: "domcontentloaded", timeout: 60_000 });
for (let i = 0; i < 20; i++) { if (/Google Cloud/i.test(await page.evaluate(() => document.body?.innerText || ""))) break; await page.waitForTimeout(1000); }
await page.getByRole("button", { name: /^Gérer$/ }).first().click({ timeout: 20_000 });
await page.waitForURL(/accountdetail/, { timeout: 30_000 }).catch(() => {});
await page.waitForTimeout(9000);
const f = page.frames().find(x => /embedded_landing_page/.test(x.url()));

const count = async () => f.evaluate(() => {
  const txt = e => (e.innerText||"").replace(/\s+/g," ").trim();
  const card = [...document.querySelectorAll("div,section")]
    .filter(c => /(^|\s)Transactions(\s|$)/.test(txt(c)) && /\d{1,2}\s*[–-]/.test(txt(c)))
    .sort((a,b)=>txt(a).length-txt(b).length)[0];
  return card ? [...card.querySelectorAll("*")].filter(e => e.hasAttribute("jsaction") || /^(BUTTON|I|SVG)$/.test(e.tagName)).length : -1;
});
console.log("interactive before hover:", await count());

const amount = f.getByText("309,58 €", { exact: false }).first();
await amount.scrollIntoViewIfNeeded().catch(()=>{});
await amount.hover({ timeout: 15_000 }).catch(e => console.log("hover failed:", e.message.split("\n")[0]));
await page.waitForTimeout(2500);
console.log("interactive after hover :", await count());

const after = await f.evaluate(() => {
  const txt = e => (e.innerText||"").replace(/\s+/g," ").trim();
  const card = [...document.querySelectorAll("div,section")]
    .filter(c => /(^|\s)Transactions(\s|$)/.test(txt(c)) && /\d{1,2}\s*[–-]/.test(txt(c)))
    .sort((a,b)=>txt(a).length-txt(b).length)[0];
  return card ? [...card.querySelectorAll("*")].filter(e => e.hasAttribute("jsaction") || /^(BUTTON|I|SVG)$/.test(e.tagName))
    .map(e => ({tag:e.tagName, aria:e.getAttribute("aria-label")||"", text:txt(e).slice(0,24), cls:(e.className||"").toString().slice(0,44)})) : [];
});
after.forEach(e => console.log(`   [${e.tag}] aria="${e.aria}" text="${e.text}" cls="${e.cls}"`));
await page.screenshot({ path: `${SD}/hover.png`, fullPage: true });
console.log(`\nscreenshot ${SD}/hover.png`);
await ctx.close();
