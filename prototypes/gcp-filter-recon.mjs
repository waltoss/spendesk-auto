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
const settle = async () => {
  for (let i = 0; i < 30; i++) {
    const t = await frame.evaluate(() => document.body?.innerText || "").catch(() => "");
    if (t.trim().length > 60) return t;
    await page.waitForTimeout(1000);
  }
  return "";
};
await settle();

console.log("=== opening the État filter ===");
const chip = frame.getByText(/^État\s*:/).first();
await chip.click({ timeout: 15_000 }).catch(e => console.log("  chip click failed:", e.message.split("\n")[0]));
await page.waitForTimeout(2500);
const opts = await frame.$$eval('[role=option],[role=menuitem],[role=checkbox],label,option', els =>
  [...new Set(els.map(e => (e.innerText || e.textContent || "").replace(/\s+/g," ").trim()).filter(t => t && t.length < 40))]).catch(() => []);
console.log("options offered:", JSON.stringify(opts.slice(0, 25)));
await page.screenshot({ path: `${SD}/filter-open.png`, fullPage: true });

// try selecting every state, then apply
for (const label of ["Tous", "Tout", "Payé", "Payée", "Fermé", "Clos"]) {
  const o = frame.getByText(new RegExp(`^${label}$`, "i")).first();
  if (await o.isVisible().catch(() => false)) { console.log(`  selecting "${label}"`); await o.click().catch(() => {}); break; }
}
const apply = frame.getByRole("button", { name: /Appliquer|Apply/i }).first();
if (await apply.isVisible().catch(() => false)) { await apply.click().catch(() => {}); console.log("  clicked Appliquer"); }
await page.waitForTimeout(6000);

const text = await frame.evaluate(() => document.body?.innerText || "").catch(() => "");
console.log("\n=== after filter change ===\n" + text.slice(0, 1200));
await page.screenshot({ path: `${SD}/filter-applied.png`, fullPage: true });
console.log(`\nscreenshots: ${SD}/filter-open.png  ${SD}/filter-applied.png`);
await ctx.close();
