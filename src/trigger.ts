// The "one click, when you decide" path.
//
// A scheduled run cannot finish a fresh charge on its own: the description needs a Spendesk
// session (DESIGN §8.3), the session lives 60 minutes, and the laptop sleeps. Something has
// to ask. Opening a browser window unprompted is the obvious way and the wrong one — it
// interrupts, and the daily plist deliberately avoids exactly that.
//
// So the run sends an email with a link, and this listens for the click. Nothing opens
// until you choose to open it.
//
// Why a local HTTP listener rather than a custom URL scheme: a plain http:// link renders
// and clicks in every mail client, including Gmail on the web, where a custom scheme is not
// even a link. And why this is safe to depend on where keep-warm was not — `KeepAlive` keeps
// a process resident and restarts it at login. No timer is involved, so the sleep problem
// that made `StartInterval` useless (see REDESIGN §6) cannot arise.
import { timingSafeEqual } from "node:crypto";
import * as log from "./log.ts";
import { start } from "./jobs.ts";
import { handle as dashboard, hostAllowed } from "./dashboard/index.ts";

const PORT = Number(Bun.env["SPENDESK_TRIGGER_PORT"] ?? 8787);
const TOKEN_FILE = `${import.meta.dir}/../.spendesk-trigger`;

/**
 * A fresh token per email, so a link in an old digest stops working once a newer one is
 * sent. The token reaches you through your inbox; rotating it bounds how long a leaked
 * copy is worth anything.
 */
export async function mintToken(): Promise<string> {
  const token = crypto.randomUUID().replace(/-/g, "");
  await Bun.write(TOKEN_FILE, token);
  return token;
}

async function currentToken(): Promise<string | null> {
  const file = Bun.file(TOKEN_FILE);
  return (await file.exists()) ? (await file.text()).trim() || null : null;
}

export const LABEL = "com.theodo.spendesk.trigger";

/**
 * Is the listener actually up — and if not, start it.
 *
 * Needed because `RunAtLoad` does not reliably spawn a job on this machine: launchd
 * reports `pended nondemand spawn = speculative` and never gets to it, which is also why
 * keep-warm never ran once. `kickstart` forces it, and `KeepAlive` holds it afterwards.
 *
 * The run calls this before offering a link. An emailed link to a listener that is not
 * listening is worse than no link at all: it is an urgent mail whose one action fails
 * silently, and the fallback text ("bun run reauth") would have worked.
 */
export async function ensureListening(): Promise<boolean> {
  if (await probe()) return true;
  try {
    const uid = process.getuid?.() ?? 501;
    const proc = Bun.spawn(["launchctl", "kickstart", `gui/${uid}/${LABEL}`], { stdout: "ignore", stderr: "ignore" });
    await proc.exited;
  } catch {
    return false;
  }
  await Bun.sleep(1500);
  return probe();
}

/** A bad token is expected to be refused: 403 proves something is listening and sane. */
async function probe(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/go?t=probe`, {
      headers: { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" },
      signal: AbortSignal.timeout(2000),
    });
    return res.status === 403;
  } catch {
    return false;
  }
}

export const actionUrl = (token: string): string => `http://127.0.0.1:${PORT}/go?t=${token}`;

/** Length-safe, and constant-time for equal lengths: never leak the token by timing. */
function tokenMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const page = (title: string, body: string, status = 200): Response =>
  new Response(
    `<!doctype html><meta charset="utf-8"><title>${title}</title>
     <style>body{margin:0;min-height:100vh;display:grid;place-items:center;
       font:15px/1.6 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;background:#f6f6f7;color:#18181b}
       .card{width:min(520px,90vw);background:#fff;border:1px solid #e4e4e7;border-radius:14px;padding:34px 38px}
       h1{font-size:21px;margin:0 0 10px}p{margin:0 0 10px;color:#3f3f46}</style>
     <div class="card"><h1>${title}</h1>${body}</div>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );

export function serve(): void {
  const server = Bun.serve({
    hostname: "127.0.0.1", // never reachable from another machine
    port: PORT,
    async fetch(req) {
      // Before anything else, for every route: see src/dashboard/index.ts.
      if (!hostAllowed(req, PORT)) return new Response("forbidden", { status: 403 });
      const url = new URL(req.url);
      if (url.pathname !== "/go") return (await dashboard(req, PORT)) ?? new Response("not found", { status: 404 });
      if (req.method !== "GET") return new Response("not found", { status: 404 });

      // Only a real click. A page you happen to be visiting can issue requests to
      // localhost, but those arrive as fetch/image loads — `navigate`/`document` means a
      // top-level navigation, which is what following a link in an email produces.
      const mode = req.headers.get("sec-fetch-mode");
      const dest = req.headers.get("sec-fetch-dest");
      if (mode && mode !== "navigate") return new Response("forbidden", { status: 403 });
      if (dest && dest !== "document") return new Response("forbidden", { status: 403 });

      const expected = await currentToken();
      const given = url.searchParams.get("t") ?? "";
      if (!expected || !tokenMatches(given, expected)) {
        log.warn("trigger: rejected a request with a bad or stale token");
        // 403, not 200: a rejected token is a failure, and a log full of 200s would hide it.
        return page("Link expired", "<p>This link has been superseded by a newer email, or is not valid.</p>", 403);
      }

      // Detached: the browser must not sit on a spinner for the length of a full run, and
      // the run outlives this request. Its own digest reports what happened. Started
      // before the token is spent: if a run already holds the browser, the link stays
      // good for when it has finished.
      const started = start("go", "email");
      if (!started.ok)
        return page(
          "Already busy",
          `<p>Nothing was started: ${started.reason}.</p>
           <p>Try this link again in a few minutes, or follow it on the <a href="/">dashboard</a>.</p>`,
          409,
        );

      // Spend the token: a link is good for one use, so a forwarded or cached email
      // cannot start a second run.
      await Bun.write(TOKEN_FILE, "");
      log.record("trigger", {});
      log.ok("trigger: starting sign-in and run");

      return page(
        "Signing you in…",
        `<p>A Chrome window is opening. Sign in with Touch ID, then approve on the Spendesk app.</p>
         <p>Your expenses are completed straight after, and you get an email with anything
            still needing you.</p>
         <p style="color:#71717a;font-size:13.5px">Follow it on the <a href="/jobs/${started.job.id}">dashboard</a>, or close this tab.</p>`,
      );
    },
  });
  log.ok(`trigger listening on http://127.0.0.1:${server.port}/go — dashboard at http://127.0.0.1:${server.port}/`);
}
