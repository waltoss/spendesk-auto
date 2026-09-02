import { chromium } from "playwright";
const SD = "/private/tmp/claude-501/-Users-waltoss-Code-Theodo-Playground-cursor-billing/1e01cfa3-edc5-4d5f-a2cd-ca3e4d603aea/scratchpad";
const ctx = await chromium.launchPersistentContext(process.cwd() + "/.browser-data", {
  channel: "chrome", chromiumSandbox: true, headless: process.argv.includes("--headless"),
  acceptDownloads: true, viewport: { width: 1500, height: 1050 },
  ignoreDefaultArgs: ["--disable-extensions", "--enable-automation"],
});
const page = ctx.pages()[0] || (await ctx.newPage());
await page.goto("https://payments.google.com/gp/w/u/0/home/documentcenter", { waitUntil: "domcontentloaded", timeout: 60_000 });

const getFrame = async () => {
  for (let i = 0; i < 40; i++) {
    const f = page.frames().find(f => f !== page.mainFrame() && /payments\/u\/\d+\/documentcenter/.test(f.url()));
    if (f) return f;
    await page.waitForTimeout(750);
  }
  throw new Error("iframe not found");
};
let frame = await getFrame();
for (let i = 0; i < 30; i++) {
  const t = await frame.evaluate(() => document.body?.innerText || "").catch(() => "");
  if (t.includes("Factures") || t.includes("document")) break;
  await page.waitForTimeout(1000);
}

console.log("=== opening the view selector ===");
await frame.getByText(/Factures en cours et notes de débit/).first().click({ timeout: 15_000 }).catch(e => console.log("  click failed:", e.message.split("\n")[0]));
await page.waitForTimeout(2500);
const views = await frame.$$eval('[role=option],[role=menuitem],li,a', els =>
  [...new Set(els.map(e => (e.innerText || "").replace(/\s+/g," ").trim()).filter(t => t && t.length < 60))]).catch(() => []);
console.log("view options:", JSON.stringify(views.slice(0, 20)));
await page.screenshot({ path: `${SD}/views.png`, fullPage: true });

for (const want of [/Tous les documents/i, /Toutes les factures/i, /Tous/i, /All documents/i]) {
  const o = frame.getByText(want).first();
  if (await o.isVisible().catch(() => false)) {
    console.log(`  selecting: ${(await o.innerText()).trim()}`);
    await o.click().catch(() => {});
    break;
  }
}
await page.waitForTimeout(7000);
frame = await getFrame();
const text = await frame.evaluate(() => document.body?.innerText || "").catch(() => "");
console.log("\n=== after selecting a view ===\n" + text.slice(0, 1300));
await page.screenshot({ path: `${SD}/view-applied.png`, fullPage: true });
console.log(`\nscreenshots: ${SD}/views.png ${SD}/view-applied.png`);
await ctx.close();
