// Re-authentication with an explained UX.
//
// This window opens by itself, which is alarming unless it says why. So it never opens
// onto a bare login page: an explainer states what the automation is, how many expenses
// are waiting and how long until the card blocks (queried live), then one button, then a
// success page, then it closes itself.
//
// Two steps, neither scriptable: the Google passkey (Touch ID) and PSD2 strong customer
// authentication approved on the Spendesk phone app. So this needs the user at their Mac,
// with their phone.
//
// -- On Bun.WebView -----------------------------------------------------------------
// `Bun.WebView` does exist in Bun 1.4.0 and was tried here, because rendering the
// explainer through Playwright's `page.setContent()` is the least elegant part of this
// file. It cannot do this job, for two independent reasons:
//
//   1. `new Bun.WebView({ headless: false })` throws
//      "headless: false is not yet implemented". There is no visible window to put an
//      explainer in, and an invisible explainer explains nothing.
//   2. Even if there were, the sign-in has to happen in the *same* browser profile that
//      the daily job uses — `.browser-data/`, a Chrome persistent context holding the
//      Spendesk, Google and Cursor cookies. WebView's `dataStore` is its own store.
//      Explaining in one window and signing in in another would be worse than now.
//
// So Playwright stays, and `channel: "chrome"` with it: macOS will not hand a passkey to
// Chrome for Testing (DESIGN §11).
import type { BrowserContext } from "playwright";
import { me, defaults, rules } from "./config.ts";
import { openContext } from "./browser.ts";
import { loggedOut as cursorLoggedOut } from "./vendors/cursor.ts";
import { sessionAlive, APP } from "./spendesk/auth.ts";
import { resolveMember } from "./spendesk/schema.ts";
import { listIncompletePayables } from "./spendesk/queue.ts";
import { requiredFields } from "./rules.ts";
import * as log from "./log.ts";

interface Surface {
  name: string;
  loginUrl: string;
  how: string;
  alive: (context: BrowserContext) => Promise<boolean>;
  recheck: (context: BrowserContext) => Promise<boolean>;
  pollMs: number;
}

const GOOGLE_PAYMENTS = "https://payments.google.com/gp/w/u/0/home/subscriptionsandservices";

async function cursorAlive(context: BrowserContext): Promise<boolean> {
  const page = await context.newPage();
  try {
    return !(await cursorLoggedOut(page));
  } catch {
    return false;
  } finally {
    await page.close().catch(() => {});
  }
}

async function googleAlive(context: BrowserContext): Promise<boolean> {
  const page = await context.newPage();
  try {
    await page.goto(GOOGLE_PAYMENTS, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
    return !/accounts\.google\.com|\/ServiceLogin/i.test(page.url());
  } catch {
    return false;
  } finally {
    await page.close().catch(() => {});
  }
}

// Two independent sessions expire, and they expire together often enough that asking for
// them one at a time would mean two interruptions. So the window lists whatever is
// actually dead and waits until all of it is alive.
const SURFACES: Surface[] = [
  {
    name: "Spendesk",
    loginUrl: `${APP}/auth/login`,
    how: "Google SSO, your passkey (Touch ID), then a tap on the Spendesk phone app.",
    alive: (context) => sessionAlive(context, { allowRefresh: true }),
    recheck: (context) => sessionAlive(context, { allowRefresh: false }),
    pollMs: 2500, // one cheap API request
  },
  {
    name: "Google",
    loginUrl: GOOGLE_PAYMENTS,
    how: "Your Google account — needed to fetch the GCP invoices.",
    alive: googleAlive,
    recheck: googleAlive,
    // A full page load. Polling it hard is what got this account rate-limited once
    // ("Google has temporarily blocked your account..."), so ask rarely.
    pollMs: 20_000,
  },
  {
    name: "Cursor",
    loginUrl: "https://cursor.com/dashboard?tab=billing",
    how: "Your Cursor account — needed to fetch the Cursor invoices.",
    alive: cursorAlive,
    recheck: cursorAlive,
    // Signing out lands on authenticator.cursor.sh behind a Cloudflare challenge, which is
    // a bot check and not something to automate around — hence a human doing it here.
    pollMs: 15_000,
  },
];

interface PendingWork {
  count: number | null;
  soonestHours: number | null;
}

async function pendingWork(): Promise<PendingWork> {
  try {
    const member = await resolveMember(me.email);
    // Public API only: this runs precisely when the session is dead.
    const queue = await listIncompletePayables({
      memberId: member.id,
      requiredFields: requiredFields({ defaults, rules }),
    });
    const incomplete = queue.filter((p) => p.completionState === "incomplete");
    const soonest = incomplete.map((p) => p.hoursRemaining ?? Infinity).sort((a, b) => a - b)[0] ?? null;
    return { count: incomplete.length, soonestHours: soonest === Infinity ? null : soonest };
  } catch {
    // The public API key may also need attention; say so rather than guessing zero.
    return { count: null, soonestHours: null };
  }
}

const shell = (body: string): string => `<!doctype html><meta charset="utf-8">
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
  a.btn { display:inline-block; background:#18181b; color:#fff; border-radius:9px;
          padding:13px 22px; font-size:15px; font-weight:550; text-decoration:none }
  a.btn:hover { background:#3f3f46 }
  hr { border:0; border-top:1px solid #f4f4f5; margin:26px 0 16px }
  .ok { width:46px;height:46px;border-radius:50%;background:#dcfce7;color:#16a34a;
        display:grid;place-items:center;font-size:24px;margin-bottom:18px }
</style>
<div class="card">${body}</div>`;

function explainPage({ count, soonestHours }: PendingWork, dead: Surface[]): string {
  const urgent = soonestHours !== null && soonestHours < 24;
  const stat =
    count === null
      ? `<div class="stat"><b>?</b><span>Couldn't read the queue — the public API key may also need attention.</span></div>`
      : count === 0
        ? `<div class="stat"><b>0</b><span>Nothing waiting right now. Signing in keeps tomorrow's run working.</span></div>`
        : `<div class="stat ${urgent ? "urgent" : ""}"><b>${count}</b><span>expense${count > 1 ? "s" : ""} waiting to be completed${
            soonestHours !== null ? ` — the most urgent is due in <b>${Math.max(0, Math.round(soonestHours))}h</b>` : ""
          }.</span></div>`;

  const buttons = dead
    .map(
      (s) => `<p><a class="btn" href="${s.loginUrl}">Sign in to ${s.name}</a><br>
                 <span class="muted">${s.how}</span></p>`,
    )
    .join("");

  return shell(`
    <p class="eyebrow">Spendesk expense automation</p>
    <h1>${dead.length > 1 ? "Two sign-ins needed" : `Sign in to ${dead[0]?.name ?? "Spendesk"}`}</h1>
    <p>This window opened by itself: the automation that completes your expenses each
       morning can no longer reach
       ${dead.map((s) => s.name).join(" or ")} on your behalf.</p>
    ${stat}
    ${buttons}
    <hr>
    <p class="muted">Sessions are stored in <code>.browser-data/</code> on this Mac only.
       This window closes itself once everything works.</p>
  `);
}

const successPage = ({ count }: PendingWork): string =>
  shell(`
    <div class="ok">✓</div>
    <p class="eyebrow">Spendesk expense automation</p>
    <h1>You're signed in</h1>
    <p>The session is saved. ${
      count
        ? `The next run will complete your <b>${count}</b> pending expense${count > 1 ? "s" : ""}.`
        : "Nothing is pending right now."
    }</p>
    <p class="muted">You can close this window — it will close itself in a moment.</p>
  `);

export async function reauth({
  force = false,
  timeoutMs = 600_000,
}: { force?: boolean; timeoutMs?: number } = {}): Promise<boolean> {
  const context = await openContext({ headless: false, viewport: { width: 1180, height: 860 } });
  try {
    const dead: Surface[] = [];
    for (const surface of SURFACES) {
      const alive = await surface.alive(context);
      (alive ? log.ok : log.warn)(`${surface.name}: ${alive ? "signed in" : "signed out"}`);
      if (!alive || force) dead.push(surface);
    }
    if (!dead.length) {
      log.ok("nothing to do");
      log.record("session-alive", {});
      return true;
    }

    const last = log.lastEvent("session-alive");
    const days = last ? ((Date.now() - new Date(last.at).getTime()) / 864e5).toFixed(1) : null;
    log.record("session-dead", { daysSinceAlive: days ? Number(days) : null });

    const work = await pendingWork();
    log.say(
      `Expired${days ? ` after ${days} days` : ""}: ${dead.map((s) => s.name).join(", ")}. ${work.count ?? "?"} expense(s) waiting.`,
    );

    const page = context.pages()[0] ?? (await context.newPage());
    await page.setContent(explainPage(work, dead), { waitUntil: "domcontentloaded" });

    log.say("Waiting for you to sign in (10 min)...");
    const deadline = Date.now() + timeoutMs;
    const nextCheck = new Map<string, number>(dead.map((s) => [s.name, 0]));
    const stillDead = new Set(dead.map((s) => s.name));

    while (Date.now() < deadline) {
      if (page.isClosed()) {
        log.warn("window closed before sign-in completed");
        return false;
      }
      for (const surface of dead) {
        if (!stillDead.has(surface.name) || Date.now() < (nextCheck.get(surface.name) ?? 0)) continue;
        nextCheck.set(surface.name, Date.now() + surface.pollMs);
        if (await surface.recheck(context)) {
          log.ok(`${surface.name}: signed in`);
          stillDead.delete(surface.name);
        }
      }
      if (stillDead.size === 0) {
        await page.setContent(successPage(work), { waitUntil: "domcontentloaded" }).catch(() => {});
        log.ok("signed in — session saved");
        log.record("session-alive", { via: "reauth" });
        await Bun.sleep(6000);
        return true;
      }
      await Bun.sleep(2500);
    }
    log.fail("timed out waiting for sign-in");
    return false;
  } finally {
    await context.close().catch(() => {});
  }
}
