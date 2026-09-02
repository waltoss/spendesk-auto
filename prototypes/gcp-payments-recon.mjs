// GCP invoices without the Cloud Console: the invoice UI is a payments.google.com iframe.
// Load the standalone document center, intercept its RPC, and pull the PDF tokens out.
import { chromium } from "playwright";

const ctx = await chromium.launchPersistentContext(process.cwd() + "/.browser-data", {
  channel: "chrome", chromiumSandbox: true, headless: true, acceptDownloads: true,
  viewport: { width: 1500, height: 1000 },
  ignoreDefaultArgs: ["--disable-extensions", "--enable-automation"],
});
const page = ctx.pages()[0] || (await ctx.newPage());

const rpc = [];
page.on("response", async (r) => {
  if (!/documentcenter\/submit|get_document/.test(r.url())) return;
  try { rpc.push({ url: r.url(), status: r.status(), body: await r.text() }); } catch {}
});

const URLS = [
  "https://pay.google.com/gp/w/u/0/home/documents",
  "https://payments.google.com/payments/u/0/documentcenter",
];
for (const url of URLS) {
  console.log("\n" + "=".repeat(80) + "\nTRY " + url);
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForLoadState("networkidle", { timeout: 25_000 }).catch(() => {});
    await page.waitForTimeout(8000);
    console.log("  final: " + page.url().split("?")[0]);
    const t = ((await page.textContent("body").catch(() => "")) || "").replace(/\s+/g, " ");
    console.log("  text : " + t.slice(0, 260));
    if (rpc.length) { console.log("  -> captured RPC, stopping here"); break; }
  } catch (e) { console.log("  ERROR " + e.message.split("\n")[0]); }
}

console.log(`\ncaptured ${rpc.length} RPC response(s)`);
const tokens = [];
for (const r of rpc) {
  console.log(`  ${r.status} ${r.url.split("?")[0]}  ${r.body.length}b`);
  for (const m of r.body.matchAll(/"(\/payments\/apis-secure\/doc\/u\/\d+\/get_document_archive)","([^"]+)"/g))
    tokens.push({ path: m[1], token: m[2] });
  for (const m of r.body.matchAll(/NEBULA\|([0-9A-F-]{20,})/g)) console.log("    billing account in token: " + m[1]);
}
console.log(`\nfound ${tokens.length} document token(s)`);
tokens.slice(0, 5).forEach((t, i) => console.log(`  [${i}] ${t.path}  token=${t.token.slice(0, 50)}…`));

// how is the token passed?
if (tokens.length) {
  const { path: p, token } = tokens[0];
  for (const build of [
    (t) => `https://payments.google.com${p}?t=${encodeURIComponent(t)}`,
    (t) => `https://payments.google.com${p}?token=${encodeURIComponent(t)}`,
    (t) => `https://payments.google.com${p}?dr=${encodeURIComponent(t)}`,
  ]) {
    const u = build(token);
    try {
      const res = await ctx.request.get(u, { timeout: 30_000, headers: { referer: "https://payments.google.com/" } });
      const b = res.ok() ? await res.body() : null;
      console.log(`  ${u.split("?")[1].split("=")[0]}= -> ${res.status()} ${b ? b.subarray(0, 4).toString() + " " + b.length + "b" : ""}`);
      if (b && b.subarray(0, 4).toString() === "%PDF") { console.log("  *** PDF! ***"); break; }
    } catch (e) { console.log("  request failed: " + e.message.split("\n")[0]); }
  }
}
await ctx.close();
