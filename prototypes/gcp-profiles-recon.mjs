// Is "Aucun document" a scoping problem (wrong payments profile) rather than a dead end?
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
const settled = async (frame) => {
  for (let i = 0; i < 25; i++) {
    const t = await frame.evaluate(() => document.body?.innerText || "").catch(() => "");
    if (t.trim().length > 60) return t;
    await page.waitForTimeout(1000);
  }
  return "";
};

// Payments profiles are addressable by id in the URL.
const PROFILES = process.argv.slice(2).filter(a => /^\d{10,}$/.test(a));
const ids = PROFILES.length ? PROFILES : ["231562568775", "171450813977", "225919287602"];

for (const pid of ids) {
  const url = `https://payments.google.com/gp/w/u/0/home/documentcenter?pid=${pid}`;
  console.log("\n" + "=".repeat(74) + `\nPROFILE ${pid}`);
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const frame = await frameOf();
    if (!frame) { console.log("  no iframe"); continue; }
    let text = await settled(frame);

    // widen from the default "outstanding only" view
    const sel = frame.getByText(/Factures en cours et notes de débit/).first();
    if (await sel.isVisible().catch(() => false)) {
      await sel.click().catch(() => {});
      await page.waitForTimeout(2000);
      const all = frame.getByText(/Toutes les factures et les notes/).first();
      if (await all.isVisible().catch(() => false)) { await all.click().catch(() => {}); await page.waitForTimeout(6000); }
    }
    const f2 = await frameOf();
    text = await f2.evaluate(() => document.body?.innerText || "").catch(() => "");
    const money = [...new Set(text.match(/[\d.,]+\s?€|€\s?[\d.,]+/g) || [])].slice(0, 8);
    const dates = [...new Set(text.match(/\d{1,2}\s+\w+\.?\s+\d{4}|\w+\s+\d{1,2},\s+\d{4}/g) || [])].slice(0, 8);
    console.log("  header:", text.split("\n").filter(Boolean).slice(0, 2).join(" | "));
    console.log("  empty?:", /Aucun document/i.test(text));
    console.log("  money :", money);
    console.log("  dates :", dates);
    if (!/Aucun document/i.test(text)) console.log("  TEXT:\n   " + text.slice(0, 600).replace(/\n/g, "\n   "));
  } catch (e) { console.log("  ERROR", e.message.split("\n")[0]); }
}
await page.screenshot({ path: `${SD}/profiles.png`, fullPage: true });
console.log(`\nscreenshot ${SD}/profiles.png`);
await ctx.close();
