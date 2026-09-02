import { chromium } from "playwright";
const SD = "/private/tmp/claude-501/-Users-waltoss-Code-Theodo-Playground-cursor-billing/1e01cfa3-edc5-4d5f-a2cd-ca3e4d603aea/scratchpad";
const ctx = await chromium.launchPersistentContext(process.cwd() + "/.browser-data", {
  channel: "chrome", chromiumSandbox: true, headless: process.argv.includes("--headless"),
  acceptDownloads: true, viewport: { width: 1500, height: 1050 },
  ignoreDefaultArgs: ["--disable-extensions", "--enable-automation"],
});
const page = ctx.pages()[0] || (await ctx.newPage());
const frameOf = async () => {
  for (let i = 0; i < 40; i++) {
    const f = page.frames().find(f => f !== page.mainFrame() && /payments\/u\/\d+\/documentcenter/.test(f.url()));
    if (f) return f;
    await page.waitForTimeout(750);
  }
  return null;
};
const txt = async (f) => (await f.evaluate(() => document.body?.innerText || "").catch(() => "")) || "";

await page.goto("https://payments.google.com/gp/w/u/0/home/documentcenter", { waitUntil: "domcontentloaded", timeout: 60_000 });
let frame = await frameOf();
for (let i = 0; i < 25 && (await txt(frame)).trim().length < 60; i++) await page.waitForTimeout(1000);

// 1. what profiles does the switcher actually offer?
console.log("=== profile switcher (main page) ===");
const sw = page.getByRole("button", { name: /Theodo|Hokla/ }).first();
if (await sw.isVisible().catch(() => false)) {
  await sw.click().catch(() => {});
  await page.waitForTimeout(2500);
  const items = await page.$$eval('[role=menuitem],[role=option],li,a', els =>
    [...new Set(els.map(e => (e.innerText || "").replace(/\s+/g," ").trim()).filter(t => t && t.length < 60))]).catch(() => []);
  console.log("  options:", JSON.stringify(items.slice(0, 20)));
  await page.keyboard.press("Escape").catch(() => {});
} else console.log("  switcher not found as a button");
await page.waitForTimeout(1500);

// 2. widen the view, then add a payer filter
frame = await frameOf();
const view = frame.getByText(/Factures en cours et notes de débit/).first();
if (await view.isVisible().catch(() => false)) {
  await view.click().catch(() => {}); await page.waitForTimeout(2000);
  await frame.getByText(/Toutes les factures et les notes/).first().click().catch(() => {});
  await page.waitForTimeout(5000);
}
frame = await frameOf();

console.log("\n=== + Ajouter un filtre ===");
await frame.getByText(/\+ Ajouter un filtre/).first().click({ timeout: 15_000 }).catch(e => console.log("  ", e.message.split("\n")[0]));
await page.waitForTimeout(2500);
const fopts = await frame.$$eval('[role=option],[role=menuitem],li,label,button', els =>
  [...new Set(els.map(e => (e.innerText || "").replace(/\s+/g," ").trim()).filter(t => t && t.length < 45))]).catch(() => []);
console.log("  filter fields:", JSON.stringify(fopts.slice(0, 22)));
await page.screenshot({ path: `${SD}/addfilter.png`, fullPage: true });

for (const label of [/Client\s*\/\s*Payeur/i, /Payeur/i, /Client/i]) {
  const o = frame.getByText(label).first();
  if (await o.isVisible().catch(() => false)) { console.log(`  choosing field: ${(await o.innerText()).trim()}`); await o.click().catch(() => {}); break; }
}
await page.waitForTimeout(2500);
const vals = await frame.$$eval('[role=option],[role=menuitem],li,label', els =>
  [...new Set(els.map(e => (e.innerText || "").replace(/\s+/g," ").trim()).filter(t => t && t.length < 45))]).catch(() => []);
console.log("  payer values:", JSON.stringify(vals.slice(0, 18)));
const gc = frame.getByText(/^Google\s*Cloud$/i).first();
if (await gc.isVisible().catch(() => false)) { console.log("  selecting Google Cloud"); await gc.click().catch(() => {}); }
const apply = frame.getByRole("button", { name: /Appliquer|Apply/i }).first();
if (await apply.isVisible().catch(() => false)) { await apply.click().catch(() => {}); console.log("  applied"); }
await page.waitForTimeout(7000);

frame = await frameOf();
const t = await txt(frame);
console.log("\n=== result ===");
console.log("  empty?:", /Aucun document/i.test(t));
console.log(t.slice(0, 900));
await page.screenshot({ path: `${SD}/payer-applied.png`, fullPage: true });
console.log(`\nscreenshots: ${SD}/addfilter.png ${SD}/payer-applied.png`);
await ctx.close();
