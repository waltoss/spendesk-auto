// The daily liveness check. No UI, one request. Exit 0 = alive, 1 = dead.
import path from "node:path";
import { chromium } from "playwright";

const PROFILE = path.resolve(process.cwd(), ".browser-data");
const COMPANY_ID = "2avcxkezrxmosd";

const context = await chromium.launchPersistentContext(PROFILE, {
  channel: "chrome",
  chromiumSandbox: true,
  headless: true,
  ignoreDefaultArgs: ["--disable-extensions", "--enable-automation"],
});

try {
  const res = await context.request.get(
    `https://api.spendesk.com/api/${COMPANY_ID}/custom-fields`,
    { headers: { origin: "https://app.spendesk.com", referer: "https://app.spendesk.com/" }, timeout: 15_000 },
  );
  console.log(`session: ${res.ok() ? "ALIVE" : "DEAD"} (HTTP ${res.status()})`);

  // Where does the credential actually live?
  const ck = (await context.cookies()).filter((c) => c.domain.includes("spendesk"));
  console.log(`spendesk cookies: ${ck.map((c) => c.name).join(", ") || "none"}`);

  const page = await context.newPage();
  await page.goto("https://app.spendesk.com/", { waitUntil: "domcontentloaded", timeout: 30_000 });
  const store = await page.evaluate(() => ({
    local: Object.keys(localStorage),
    session: Object.keys(sessionStorage),
  }));
  console.log(`localStorage keys  : ${store.local.join(", ") || "none"}`);
  console.log(`sessionStorage keys: ${store.session.join(", ") || "none"}`);
  console.log(`landed on: ${page.url()}`);
  process.exitCode = res.ok() ? 0 : 1;
} finally {
  await context.close();
}
