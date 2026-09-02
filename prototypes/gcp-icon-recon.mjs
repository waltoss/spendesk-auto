import { chromium } from "playwright";
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
const f = page.frames().find(f => /embedded_landing_page/.test(f.url()));

const info = await f.evaluate(() => {
  const txt = (e) => (e.innerText || "").replace(/\s+/g, " ").trim();
  const card = [...document.querySelectorAll("div,section")]
    .filter(c => /(^|\s)Transactions(\s|$)/.test(txt(c)) && /\d{1,2}\s*[–-]\s*\d{1,2}/.test(txt(c)))
    .sort((a,b)=>txt(a).length-txt(b).length)[0];
  if (!card) return { err: "no card" };
  const desc = [...card.querySelectorAll("*")];
  return {
    cardHTML: card.outerHTML.slice(0, 2200),
    interactive: desc.filter(e => e.hasAttribute("jsaction") || /^(BUTTON|A|I|SVG)$/.test(e.tagName))
      .map(e => ({ tag: e.tagName, text: txt(e).slice(0,26), aria: e.getAttribute("aria-label")||"",
                   role: e.getAttribute("role")||"", cls: (e.className||"").toString().slice(0,40) })).slice(0, 20),
  };
});
console.log("interactive elements in Transactions card:");
(info.interactive||[]).forEach(e => console.log(`  [${e.tag}] role=${e.role} aria="${e.aria}" text="${e.text}" cls="${e.cls}"`));
console.log("\n--- card HTML (truncated) ---\n" + (info.cardHTML||info.err));
await ctx.close();
