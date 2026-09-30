// The dashboard, served by the trigger listener that is already resident on 127.0.0.1.
//
// Binding to loopback keeps the network out, but not the websites you visit: any page can
// send requests to 127.0.0.1, and a DNS-rebinding page can even read the replies. The page
// shows your expenses and its buttons write to Spendesk, so three checks sit in front of it:
//
//   Host header     must name this listener. A rebinding attack arrives under the
//                   attacker's own host name, so this is what stops it reading anything.
//   same origin     a button press must come from this page (Origin / Sec-Fetch-Site), not
//                   from a form on some other site posting here.
//   CSRF token      per listener process, embedded in the page. Belt and braces for the
//                   above, and it makes a page left open across a restart fail loudly.
//
// Plus frame-ancestors 'none', so no site can frame the page and trick a click on a button.
import path from "node:path";
import { defaults, rules } from "../config.ts";
import * as log from "../log.ts";
import { blocker, getJob, isJobKind, isRunning, JOBS, listJobs, readJobLog, start, type JobKind } from "../jobs.ts";
import {
  invoiceFiles,
  isInvoiceName,
  lastOf,
  ruleRows,
  runRows,
  spendeskSignIn,
  vendorSignIn,
} from "./state.ts";
import { APP_JS, dashboardPage, errorFragment, esc, jobPage, messagePage, queueFragment } from "./page.ts";
import { queueView } from "./queue.ts";

const ROOT = path.resolve(import.meta.dir, "../..");
const INVOICES = path.join(ROOT, "invoices");

const CSRF = crypto.randomUUID().replace(/-/g, "");

const SECURITY_HEADERS = {
  "cache-control": "no-store",
  // Not "no-referrer": Chrome then sends `Origin: null` on the page's own form posts, and
  // the same-origin check below refuses every button. same-origin still leaks nothing.
  "referrer-policy": "same-origin",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; img-src 'self' data:; " +
  "form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

const html = (body: string, status = 200): Response =>
  new Response(body, {
    status,
    headers: { ...SECURITY_HEADERS, "content-security-policy": CSP, "content-type": "text/html; charset=utf-8" },
  });

const allowedHosts = (port: number): string[] => [`127.0.0.1:${port}`, `localhost:${port}`];

/** A DNS-rebinding request carries the attacker's host name; a real visit carries ours. */
export function hostAllowed(req: Request, port: number): boolean {
  return allowedHosts(port).includes(req.headers.get("host") ?? "");
}

/**
 * Was this POST sent by our own page? Browsers attach Origin to every POST and
 * Sec-Fetch-Site to every request; requiring one of them means a request that carries
 * neither — something that is not a browser, or a very old one — is refused too.
 */
export function sameOrigin(req: Request, port: number): boolean {
  const origin = req.headers.get("origin");
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return false;
  if (origin && !allowedHosts(port).some((h) => origin === `http://${h}`)) return false;
  return Boolean(origin || site);
}

const VENDORS = [
  { name: "Google", adapter: "gcp" },
  { name: "Anthropic", adapter: "anthropic" },
  { name: "Cursor", adapter: "cursor" },
];

function render(): string {
  const events = log.readEvents();
  const jobs = listJobs();
  const running = jobs.find(isRunning) ?? null;
  const blockers = Object.fromEntries(
    (Object.keys(JOBS) as JobKind[]).map((k) => [k, blocker(k)]),
  ) as Record<JobKind, string | null>;
  return dashboardPage({
    now: Date.now(),
    csrf: CSRF,
    spendesk: spendeskSignIn(events),
    vendors: VENDORS.map((v) => vendorSignIn(events, v.name, v.adapter)),
    runs: runRows(events),
    jobs,
    running,
    blockers,
    invoices: invoiceFiles(INVOICES, events),
    rules: ruleRows(rules, events),
    defaults,
    lastBlockWarning: lastOf(events, "block-warning")?.at ?? null,
    lastEmailClick: lastOf(events, "trigger")?.at ?? null,
    schedule: "daily run at 08:00 (launchd)",
  });
}

/** Handle a dashboard request, or return null to let the caller route it (e.g. /go). */
export async function handle(req: Request, port: number): Promise<Response | null> {
  const url = new URL(req.url);
  const { pathname } = url;

  if (req.method === "GET") {
    if (pathname === "/") return html(render());
    if (pathname === "/favicon.ico") return new Response(null, { status: 204 });
    if (pathname === "/app.js")
      return new Response(APP_JS, {
        headers: { ...SECURITY_HEADERS, "content-type": "text/javascript; charset=utf-8" },
      });
    if (pathname === "/fragment/queue") {
      try {
        return html(queueFragment(await queueView({ refresh: url.searchParams.has("refresh") })));
      } catch (e) {
        return html(errorFragment(e instanceof Error ? e.message : String(e)));
      }
    }
    if (pathname.startsWith("/jobs/")) {
      const job = getJob(decodeURIComponent(pathname.slice("/jobs/".length)));
      if (!job) return html(messagePage("No such job", "It may have been pruned — only the last 60 are kept."), 404);
      return html(jobPage(job, readJobLog(job.id), isRunning(job)));
    }
    if (pathname.startsWith("/invoices/")) {
      const name = decodeURIComponent(pathname.slice("/invoices/".length));
      const file = Bun.file(path.join(INVOICES, name));
      if (!isInvoiceName(name) || !(await file.exists())) return new Response("not found", { status: 404 });
      return new Response(file, {
        headers: { ...SECURITY_HEADERS, "content-type": "application/pdf", "content-disposition": `inline; filename="${name}"` },
      });
    }
    return null;
  }

  if (req.method === "POST" && pathname === "/jobs") {
    if (!sameOrigin(req, port)) return new Response("forbidden", { status: 403 });
    const body = await req.formData().catch(() => null);
    if (body?.get("csrf") !== CSRF)
      return html(messagePage("Page out of date", "The listener restarted since this page was loaded. Go back and reload it."), 403);
    const kind = String(body.get("kind") ?? "");
    if (!isJobKind(kind)) return html(messagePage("Unknown action", esc(kind)), 400);

    const started = start(kind, "dashboard");
    if (!started.ok) return html(messagePage("Not started", esc(started.reason)), 409);
    log.ok(`dashboard: started ${kind}`);
    return new Response(null, { status: 303, headers: { location: `/jobs/${started.job.id}` } });
  }

  return null;
}
