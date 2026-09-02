// Interactive Spendesk re-auth with an explained UX.
//
//   node prototypes/reauth.mjs            # only opens if the session is actually dead
//   node prototypes/reauth.mjs --force    # always show the flow (for testing the UX)
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const ROOT = process.cwd();
const PROFILE = path.resolve(ROOT, ".browser-data");
const COMPANY_ID = "2avcxkezrxmosd";
const MEMBER_ID = "9qytin56a08wku";
const APP = "https://app.spendesk.com";
const API = "https://api.spendesk.com";
const PUBLIC_API = "https://public-api.spendesk.com";
const FORCE = process.argv.includes("--force");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- session check

async function ping(context) {
  try {
    const res = await context.request.get(`${API}/api/${COMPANY_ID}/custom-fields`, {
      headers: { origin: APP, referer: `${APP}/` },
      timeout: 10_000,
    });
    return res.ok();
  } catch {
    return false;
  }
}

// SPX_ACCESS_TOKEN is short-lived inside a year-long cookie; the SPA exchanges
// SPX_REFRESH_TOKEN for a new one. A raw request never triggers that, so a 401
// does not mean the session is dead — load the app once and ask again.
async function sessionAlive(context, { allowRefresh = true } = {}) {
  if (await ping(context)) return true;
  if (!allowRefresh) return false;

  const page = await context.newPage();
  try {
    await page.goto(`${APP}/app`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(4000);
  } catch {
    // fall through — the retry below is the real verdict
  } finally {
    await page.close().catch(() => {});
  }
  return ping(context);
}

// ------------------------------------------------- what's waiting (public API)

async function pendingWork() {
  try {
    const creds = fs.readFileSync(path.resolve(ROOT, ".spendesk-api"), "utf8");
    const id = /^ID=(.*)$/im.exec(creds)?.[1].trim();
    const secret = /^Secret=(.*)$/im.exec(creds)?.[1].trim();
    const basic = Buffer.from(`${id}:${secret}`).toString("base64");

    const tokRes = await fetch(`${PUBLIC_API}/v1/auth/token`, {
      method: "POST",
      headers: { authorization: `Basic ${basic}` },
    });
    const { access_token } = await tokRes.json();

    const res = await fetch(`${PUBLIC_API}/v1/payables/search`, {
      method: "POST",
      headers: { authorization: `Bearer ${access_token}`, "content-type": "application/json" },
      body: JSON.stringify({
        limit: 60,
        sort: "desc",
        filters: {
          operator: "and",
          subfilters: [
            { field: "requestor", operator: "=", value: [MEMBER_ID] },
            { field: "bookkeepingStatus", operator: "=", value: ["toPrepare"] },
          ],
        },
      }),
    });
    const { payables = [] } = await res.json();

    const incomplete = payables.filter((p) => {
      const cf = (p.itemLines || []).flatMap((l) =>
        (l.analyticalFieldAssociations || []).filter((a) => a.fieldKind === "customField"),
      );
      return cf.length < 3 || !p.description;
    });

    // 3-day fuse from the transaction date
    const hours = incomplete
      .map((p) => 72 - (Date.now() - new Date(p.creationDate)) / 36e5)
      .sort((a, b) => a - b);

    return { count: incomplete.length, soonestHours: hours[0] ?? null };
  } catch {
    return { count: null, soonestHours: null };
  }
}

// ---------------------------------------------------------------------- pages

const shell = (body) => `<!doctype html><meta charset="utf-8">
<style>
  :root { color-scheme: light }
  * { box-sizing: border-box }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         font: 15px/1.6 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
         background:#f6f6f7; color:#18181b }
  .card { width:min(560px, 90vw); background:#fff; border:1px solid #e4e4e7; border-radius:14px;
          padding:38px 40px; box-shadow:0 1px 2px rgba(0,0,0,.04), 0 12px 32px rgba(0,0,0,.06) }
  .eyebrow { font-size:12px; font-weight:600; letter-spacing:.09em; text-transform:uppercase; color:#8b5cf6; margin:0 0 14px }
  h1 { font-size:23px; line-height:1.3; margin:0 0 12px; letter-spacing:-.01em }
  p { margin:0 0 14px; color:#3f3f46 }
  .muted { color:#71717a; font-size:13.5px }
  .stat { display:flex; gap:10px; align-items:baseline; background:#faf5ff; border:1px solid #ede9fe;
          border-radius:10px; padding:13px 16px; margin:20px 0 24px }
  .stat b { font-size:19px; color:#6d28d9 }
  .urgent { background:#fef2f2; border-color:#fecaca } .urgent b { color:#dc2626 }
  a.btn, button { display:inline-block; background:#18181b; color:#fff; border:0; border-radius:9px;
                  padding:13px 22px; font-size:15px; font-weight:550; cursor:pointer; text-decoration:none }
  a.btn:hover, button:hover { background:#3f3f46 }
  ol { margin:0 0 22px; padding-left:20px; color:#3f3f46 } li { margin:5px 0 }
  hr { border:0; border-top:1px solid #f4f4f5; margin:26px 0 16px }
  .ok { width:46px;height:46px;border-radius:50%;background:#dcfce7;color:#16a34a;
        display:grid;place-items:center;font-size:24px;margin-bottom:18px }
</style>
<div class="card">${body}</div>`;

function explainPage({ count, soonestHours }) {
  const urgent = soonestHours !== null && soonestHours < 24;
  const stat =
    count === null
      ? `<div class="stat"><b>?</b><span>Couldn't read the queue — the public API key may also need attention.</span></div>`
      : count === 0
        ? `<div class="stat"><b>0</b><span>Nothing waiting right now. Signing in keeps tomorrow's run working.</span></div>`
        : `<div class="stat ${urgent ? "urgent" : ""}"><b>${count}</b><span>expense${count > 1 ? "s" : ""} waiting to be completed${
            soonestHours !== null
              ? ` — the most urgent is due in <b>${Math.max(0, Math.round(soonestHours))}h</b>`
              : ""
          }.</span></div>`;

  return shell(`
    <p class="eyebrow">Spendesk invoice automation</p>
    <h1>Sign in to Spendesk</h1>
    <p>This window opened by itself: the automation that completes your expenses each
       morning can no longer reach Spendesk on your behalf.</p>
    ${stat}
    <a class="btn" href="${APP}/auth/login">Sign in to Spendesk</a>
    <hr>
    <p class="muted">Google SSO, then your passkey (Touch ID) and a tap on the Spendesk
       phone app. The session is stored in <code>.browser-data/</code> on this Mac only.
       This window closes itself once it works.</p>
  `);
}

const successPage = ({ count }) =>
  shell(`
    <div class="ok">✓</div>
    <p class="eyebrow">Spendesk invoice automation</p>
    <h1>You're signed in</h1>
    <p>The session is saved. ${
      count ? `The next run will complete your <b>${count}</b> pending expense${count > 1 ? "s" : ""}.` : "Nothing is pending right now."
    }</p>
    <p class="muted">You can close this window — it will close itself in a moment.</p>
  `);

// ----------------------------------------------------------------------- main

async function main() {
  const context = await chromium.launchPersistentContext(PROFILE, {
    channel: "chrome",     // real Chrome: required for the macOS passkey provider
    chromiumSandbox: true, // else Playwright passes --no-sandbox and Chrome warns about it
    headless: false,
    viewport: { width: 1180, height: 860 },
    // Drop --enable-automation: it paints the "Chrome is being controlled by
    // automated test software" banner, which is alarming on a window the user
    // did not open. Keep extensions enabled for 1Password.
    ignoreDefaultArgs: ["--disable-extensions", "--enable-automation"],
  });

  try {
    if (!FORCE && (await sessionAlive(context))) {
      console.log("Session is still valid — nothing to do.");
      return;
    }

    const work = await pendingWork();
    console.log(`Session expired. ${work.count ?? "?"} expense(s) waiting.`);

    const page = context.pages()[0] || (await context.newPage());
    await page.setContent(explainPage(work), { waitUntil: "domcontentloaded" });

    console.log("Waiting for you to sign in (10 min)...");
    const deadline = Date.now() + 600_000;
    while (Date.now() < deadline) {
      if (page.isClosed()) { console.log("Window closed before sign-in completed."); return; }
      if (await sessionAlive(context, { allowRefresh: false })) {
        await page.setContent(successPage(work), { waitUntil: "domcontentloaded" }).catch(() => {});
        console.log("Signed in — session saved.");
        await sleep(6000);
        return;
      }
      await sleep(2500);
    }
    console.log("Timed out waiting for sign-in.");
  } finally {
    await context.close().catch(() => {});
  }
}

main().catch((e) => { console.error(`FAILED: ${e.message}`); process.exit(1); });
