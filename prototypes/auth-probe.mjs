// Probe: can we reach an authenticated Spendesk session in the automation profile,
// and what does re-auth actually require?
//
//   node prototypes/auth-probe.mjs              # bundled Chromium (no extensions)
//   node prototypes/auth-probe.mjs --chrome     # real Chrome (needed for 1Password)
//   node prototypes/auth-probe.mjs --chrome --wait 300
import path from "node:path";
import { chromium } from "playwright";

const ROOT = process.cwd();
const PROFILE = path.resolve(ROOT, ".browser-data");
const USE_CHROME = process.argv.includes("--chrome");
const waitIdx = process.argv.indexOf("--wait");
const WAIT_S = waitIdx > -1 ? Number(process.argv[waitIdx + 1]) : 180;

const APP = "https://app.spendesk.com";
const API = "https://api.spendesk.com";

async function cookieReport(context, label) {
  const all = await context.cookies();
  const sd = all.filter((c) => c.domain.includes("spendesk"));
  console.log(`\n[${label}] spendesk cookies: ${sd.length}`);
  for (const c of sd) {
    const exp = c.expires > 0 ? new Date(c.expires * 1000).toISOString().slice(0, 10) : "session";
    console.log(`   ${c.name.padEnd(28)} ${c.domain.padEnd(22)} exp=${exp} httpOnly=${c.httpOnly}`);
  }
  return sd;
}

// The real test: can we call the internal API the description PUT needs?
async function probeInternalApi(context) {
  const url = `${API}/api/2avcxkezrxmosd/custom-fields`;
  try {
    const res = await context.request.get(url, {
      headers: { origin: APP, referer: `${APP}/` },
      timeout: 20_000,
    });
    const ok = res.ok();
    let n = null;
    if (ok) { try { n = (await res.json()).length; } catch {} }
    console.log(`\n[internal API] GET /custom-fields -> ${res.status()}${n !== null ? ` (${n} fields)` : ""}`);
    return ok;
  } catch (e) {
    console.log(`\n[internal API] request failed: ${e.message}`);
    return false;
  }
}

async function main() {
  console.log(`profile : ${PROFILE}`);
  console.log(`browser : ${USE_CHROME ? "Google Chrome (channel=chrome)" : "bundled Chromium"}`);

  const context = await chromium.launchPersistentContext(PROFILE, {
    ...(USE_CHROME ? { channel: "chrome" } : {}),
    headless: false,
    viewport: { width: 1440, height: 960 },
    // Drop --enable-automation: it paints the "Chrome is being controlled by
    // automated test software" banner, which is alarming on a window the user
    // did not open. Keep extensions enabled for 1Password.
    ignoreDefaultArgs: ["--disable-extensions", "--enable-automation"],
  });

  const page = context.pages()[0] || (await context.newPage());

  await cookieReport(context, "before");
  let authed = await probeInternalApi(context);

  console.log(`\nnavigating to ${APP} ...`);
  await page.goto(APP, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  console.log(`landed on : ${page.url()}`);
  console.log(`title     : ${await page.title()}`);

  if (!authed) {
    console.log(
      `\n>>> Complete the login in the window (SSO / passkey / 1Password).\n` +
      `>>> Watching for up to ${WAIT_S}s. Closing the window ends the probe cleanly.\n`,
    );
    const deadline = Date.now() + WAIT_S * 1000;
    let lastUrl = "";
    while (Date.now() < deadline) {
      let u;
      try { u = page.url(); } catch { console.log("\n   (browser closed)"); break; }
      if (page.isClosed()) { console.log("\n   (page closed)"); break; }
      if (u !== lastUrl) {
        console.log(`   → ${challengeLabel(u)}`);
        lastUrl = u;
      }
      if (await probeInternalApiQuiet(context)) { authed = true; break; }
      await sleep(2500);
    }
  }

  console.log(`\n=== RESULT ===`);
  console.log(`authenticated to internal API: ${authed ? "YES" : "NO"}`);
  await cookieReport(context, "after");
  if (authed) await probeInternalApi(context);

  await sleep(3000);
  await context.close().catch(() => {});
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Google encodes the auth factor it is demanding in the challenge path.
const CHALLENGES = {
  pk: "PASSKEY (needs 1Password or a platform authenticator)",
  pwd: "PASSWORD (scriptable via `op item get --fields password`)",
  totp: "TOTP (scriptable via `op item get --otp`)",
  ipp: "phone prompt",
  az: "Google prompt on another device",
  sk: "security key",
  dp: "device passkey",
};

function challengeLabel(u) {
  try {
    const url = new URL(u);
    const m = url.pathname.match(/\/challenge\/([a-z]+)/i);
    if (m) {
      const kind = CHALLENGES[m[1]] || `unknown (${m[1]})`;
      return `${url.host}${url.pathname}  <<< CHALLENGE: ${kind}`;
    }
    if (url.pathname.includes("accountchooser")) return `${url.host}  (account chooser)`;
    if (url.host.includes("spendesk")) return `${url.host}${url.pathname}`;
    return `${url.host}${url.pathname}`;
  } catch { return u; }
}

async function probeInternalApiQuiet(context) {
  try {
    const res = await context.request.get(`${API}/api/2avcxkezrxmosd/custom-fields`, {
      headers: { origin: APP, referer: `${APP}/` }, timeout: 10_000,
    });
    return res.ok();
  } catch { return false; }
}

main().catch((e) => { console.error(`FAILED: ${e.message}`); process.exit(1); });
