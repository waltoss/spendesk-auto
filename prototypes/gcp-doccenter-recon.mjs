// The document list is delivered by batchexecute after hydration — capture the JSON.
import fs from "node:fs";
import { chromium } from "playwright";

const SD = "/private/tmp/claude-501/-Users-waltoss-Code-Theodo-Playground-cursor-billing/1e01cfa3-edc5-4d5f-a2cd-ca3e4d603aea/scratchpad";
const ctx = await chromium.launchPersistentContext(process.cwd() + "/.browser-data", {
  channel: "chrome", chromiumSandbox: true,
  headless: process.argv.includes("--headless"),
  acceptDownloads: true, viewport: { width: 1500, height: 1000 },
  ignoreDefaultArgs: ["--disable-extensions", "--enable-automation"],
});
const page = ctx.pages()[0] || (await ctx.newPage());

const caught = [];
page.on("response", async (r) => {
  if (!/batchexecute|get_document/.test(r.url())) return;
  try { caught.push({ url: r.url(), status: r.status(), body: await r.text() }); } catch {}
});

await page.goto("https://payments.google.com/gp/w/u/0/home/documentcenter", { waitUntil: "domcontentloaded", timeout: 60_000 });
await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
await page.waitForTimeout(10_000);

console.log("final:", page.url().split("?")[0]);
const visible = ((await page.textContent("body").catch(() => "")) || "").replace(/\s+/g, " ");
console.log("visible text:", visible.slice(0, 500));
console.log("\nframes:", page.frames().map((f) => f.url().split("?")[0]).filter((u) => u && u !== "about:blank"));

console.log(`\ncaught ${caught.length} batchexecute response(s)`);
fs.writeFileSync(`${SD}/batch.json`, JSON.stringify(caught, null, 1));
for (const c of caught) {
  const rpcids = new URL(c.url).searchParams.get("rpcids");
  console.log(`\n--- ${c.status}  rpcids=${rpcids}  ${c.body.length}b`);
  const money = [...new Set(c.body.match(/€\\?\s?[\d,]+\.\d{2}|\\u20ac[\d,.]+/g) || [])].slice(0, 12);
  const dates = [...new Set(c.body.match(/(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4}/g) || [])].slice(0, 12);
  const accts = [...new Set(c.body.match(/[0-9A-F]{6}-[0-9A-F]{6}-[0-9A-F]{6}/g) || [])];
  const docs  = [...new Set(c.body.match(/\b\d{10}\b/g) || [])].slice(0, 10);
  console.log("   money:", money, "\n   dates:", dates, "\n   accts:", accts, "\n   docids:", docs);
  if (money.length || dates.length) console.log("   sample:", c.body.slice(0, 500).replace(/\s+/g, " "));
}
await page.screenshot({ path: `${SD}/doccenter.png` });
console.log(`\nscreenshot: ${SD}/doccenter.png   raw: ${SD}/batch.json`);
await ctx.close();
