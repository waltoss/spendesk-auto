// The dashboard's HTML. Server-rendered strings, no framework: one page, read top to bottom
// — is anything urgent, can it still sign in, what did it do, what would it do.
//
// Everything that came from Spendesk, a vendor or the ledger goes through esc(): supplier
// names are third-party text, and this page can start runs.
import type { Job } from "../jobs.ts";
import { JOBS, type JobKind } from "../jobs.ts";
import type { ItemTrace } from "../types.ts";
import type { QueueView } from "./queue.ts";
import type { InvoiceFile, RuleRow, RunRow, SignIn } from "./state.ts";

export const esc = (s: unknown): string =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "never";
  const s = Math.round((now - new Date(iso).getTime()) / 1000);
  if (s < 0) return "just now";
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 36 * 3600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

const when = (iso: string | null | undefined): string =>
  iso
    ? `<time title="${esc(new Date(iso).toLocaleString("fr-FR"))}">${esc(ago(iso))}</time>`
    : `<span class="muted">never</span>`;

const fuse = (h: number | null): string => {
  if (h === null) return `<span class="muted">unknown</span>`;
  const n = Math.round(h);
  return n >= 0
    ? `<span class="${n < 24 ? "warn" : ""}">${n} h left</span>`
    : `<span class="bad">overdue by ${-n} h</span>`;
};

const money = (amount: number, currency: string): string =>
  `${esc(amount.toFixed(2))}&nbsp;${esc(currency)}`;

const badge = (tone: "ok" | "warn" | "bad" | "muted", text: string): string =>
  `<span class="badge ${tone}">${esc(text)}</span>`;

const STYLE = `
  :root { color-scheme: light; --line:#e4e4e7; --soft:#f4f4f5; --text:#18181b; --muted:#71717a;
          --ok:#16a34a; --okbg:#dcfce7; --warn:#b45309; --warnbg:#fef3c7; --bad:#dc2626; --badbg:#fee2e2;
          --accent:#6d28d9 }
  * { box-sizing: border-box }
  body { margin:0; font:14px/1.5 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
         background:#f6f6f7; color:var(--text) }
  main { max-width:1180px; margin:0 auto; padding:28px 24px 60px }
  header { display:flex; align-items:baseline; gap:14px; flex-wrap:wrap; margin-bottom:18px }
  h1 { font-size:22px; margin:0; letter-spacing:-.01em }
  h2 { font-size:15px; margin:0 0 12px; display:flex; align-items:center; gap:10px }
  h2 .muted { font-weight:400; font-size:13px }
  section { background:#fff; border:1px solid var(--line); border-radius:12px; padding:18px 20px; margin:0 0 16px }
  .grid { display:grid; gap:12px; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)) }
  .tile { border:1px solid var(--line); border-radius:10px; padding:12px 14px }
  .tile b { display:block; font-size:14px; margin-bottom:2px }
  .muted { color:var(--muted) }
  .ok { color:var(--ok) } .warn { color:var(--warn) } .bad { color:var(--bad) }
  .badge { display:inline-block; font-size:11.5px; font-weight:600; padding:1px 8px; border-radius:99px; white-space:nowrap }
  .badge.ok { background:var(--okbg); color:var(--ok) } .badge.warn { background:var(--warnbg); color:var(--warn) }
  .badge.bad { background:var(--badbg); color:var(--bad) } .badge.muted { background:var(--soft); color:var(--muted) }
  .alert { border-radius:10px; padding:11px 14px; margin:0 0 16px; font-weight:500 }
  .alert.bad { background:var(--badbg); color:#991b1b; border:1px solid #fecaca }
  .alert.warn { background:var(--warnbg); color:#92400e; border:1px solid #fde68a }
  .alert.info { background:#ede9fe; color:#4c1d95; border:1px solid #ddd6fe }
  table { width:100%; border-collapse:collapse }
  th { text-align:left; font-size:12px; font-weight:600; color:var(--muted); padding:6px 8px; border-bottom:1px solid var(--line) }
  td { padding:8px; border-bottom:1px solid var(--soft); vertical-align:top }
  tr:last-child td { border-bottom:0 }
  td.nowrap { white-space:nowrap }
  td.num { text-align:right; white-space:nowrap; font-variant-numeric:tabular-nums }
  code, pre { font:12.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace }
  pre { background:#0f0f11; color:#e4e4e7; padding:14px 16px; border-radius:10px; overflow:auto; white-space:pre-wrap; margin:0 }
  form.actions { display:flex; flex-wrap:wrap; gap:8px; margin:0 }
  button { font:inherit; font-weight:550; border:1px solid var(--line); background:#fff; color:var(--text);
           border-radius:8px; padding:7px 13px; cursor:pointer }
  button:hover { background:var(--soft) }
  button.primary { background:var(--text); color:#fff; border-color:var(--text) } button.primary:hover { background:#3f3f46 }
  button:disabled { opacity:.45; cursor:not-allowed }
  details summary { cursor:pointer }
  ul.trace { margin:6px 0 0; padding-left:18px } ul.trace li { margin:1px 0 }
  a { color:var(--accent) }
  .row-title { font-weight:550 }
`;

export function shell(title: string, body: string, { refreshSeconds }: { refreshSeconds?: number } = {}): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${refreshSeconds ? `<meta http-equiv="refresh" content="${refreshSeconds}">` : ""}
<title>${esc(title)}</title>
<style>${STYLE}</style>
<main>${body}</main>
<script src="/app.js"></script>
</html>`;
}

/** Fills in the lazily loaded sections. Served from /app.js so the CSP can forbid inline script. */
export const APP_JS = `
async function load(el, refresh) {
  const url = el.dataset.fragment + (refresh ? "?refresh=1" : "");
  el.setAttribute("aria-busy", "true");
  try {
    const res = await fetch(url, { credentials: "same-origin" });
    el.innerHTML = await res.text();
  } catch (e) {
    el.textContent = "Could not load: " + e;
  }
  el.removeAttribute("aria-busy");
}
document.querySelectorAll("[data-fragment]").forEach((el) => load(el, false));
document.addEventListener("click", (ev) => {
  const btn = ev.target.closest("[data-reload]");
  if (!btn) return;
  ev.preventDefault();
  const el = document.getElementById(btn.dataset.reload);
  if (el) load(el, true);
});
`;

// -------------------------------------------------------------------------- sections

export interface DashboardData {
  now: number;
  csrf: string;
  spendesk: SignIn;
  vendors: SignIn[];
  runs: RunRow[];
  jobs: Job[];
  running: Job | null;
  blockers: Partial<Record<JobKind, string | null>>;
  invoices: InvoiceFile[];
  rules: RuleRow[];
  defaults: Record<string, string>;
  lastBlockWarning: string | null;
  lastEmailClick: string | null;
  schedule: string;
}

export function dashboardPage(d: DashboardData): string {
  const body = [
    `<header><h1>Spendesk expense automation</h1>
       <span class="muted">updated ${esc(new Date(d.now).toLocaleTimeString("fr-FR"))} · ${esc(d.schedule)}</span></header>`,
    alerts(d),
    signIns(d),
    actions(d),
    `<section><h2>Waiting in Spendesk <span class="muted">payables view, live via the public API — lags the card by ~2 days</span>
       <button data-reload="queue" style="margin-left:auto">Refresh</button></h2>
       <div id="queue" data-fragment="/fragment/queue"><p class="muted">Loading…</p></div></section>`,
    lastRun(d),
    history(d),
    invoices(d),
    rulesSection(d),
  ].join("\n");
  return shell("Spendesk automation", body, { refreshSeconds: d.running ? 8 : undefined });
}

function alerts(d: DashboardData): string {
  const out: string[] = [];
  if (d.lastBlockWarning && d.now - new Date(d.lastBlockWarning).getTime() < 36 * 3600e3)
    out.push(
      `<div class="alert bad">Spendesk warned that the card will be blocked — ${when(d.lastBlockWarning)}. Missing receipts or fields.</div>`,
    );
  if (d.running)
    out.push(
      `<div class="alert info">“${esc(d.running.label)}” is running — started ${when(d.running.startedAt)}.
         <a href="/jobs/${esc(d.running.id)}">Watch its output</a></div>`,
    );
  const crash = d.runs[0]?.status === "crash" ? d.runs[0] : null;
  if (crash)
    out.push(`<div class="alert warn">The last run crashed ${when(crash.startedAt)}: <code>${esc(crash.summary)}</code></div>`);
  return out.join("");
}

function signInTile(s: SignIn): string {
  const tone = s.state === "alive" ? "ok" : s.state === "dead" ? "bad" : s.state === "stale" ? "warn" : "muted";
  const label = { alive: "signed in", stale: "expired?", dead: "signed out", unknown: "unknown" }[s.state];
  return `<div class="tile"><b>${esc(s.name)} ${badge(tone, label)}</b>
    <div class="muted">${esc(s.note)}</div>
    <div class="muted">last OK ${when(s.lastAlive)}${s.lastDead ? ` · last failure ${when(s.lastDead)}` : ""}</div></div>`;
}

function button(d: DashboardData, kind: JobKind, primary = false): string {
  const why = d.blockers[kind];
  return `<button name="kind" value="${kind}"${primary ? ` class="primary"` : ""}${
    why ? ` disabled title="${esc(why)}"` : ""
  }>${esc(JOBS[kind].label)}</button>`;
}

const form = (d: DashboardData, inner: string): string =>
  `<form class="actions" method="post" action="/jobs"><input type="hidden" name="csrf" value="${esc(d.csrf)}">${inner}</form>`;

function signIns(d: DashboardData): string {
  return `<section><h2>Sign-ins <span class="muted">last known state, from the run log — nothing is probed when this page loads</span></h2>
    <div class="grid">${[d.spendesk, ...d.vendors].map(signInTile).join("")}</div>
    <div style="margin-top:14px">${form(d, [button(d, "go", d.spendesk.state !== "alive"), button(d, "reauth"), button(d, "check")].join(""))}</div>
    <p class="muted" style="margin:10px 0 0">Sign-in opens a Chrome window: Touch ID, then approve on the Spendesk phone app.
      ${d.lastEmailClick ? `Last emailed link clicked ${when(d.lastEmailClick)}.` : ""}</p>
  </section>`;
}

function actions(d: DashboardData): string {
  const jobs = d.jobs.slice(0, 8);
  return `<section><h2>Run</h2>
    ${form(d, [button(d, "dry"), button(d, "run", true), button(d, "rules"), button(d, "fetch-gcp"), button(d, "fetch-anthropic"), button(d, "fetch-cursor")].join(""))}
    <p class="muted" style="margin:10px 0 0">A dry run decides everything and writes nothing. Run now writes to Spendesk, exactly like the 08:00 run.
      One job at a time: they all share one Chrome profile.</p>
    ${
      jobs.length
        ? `<table style="margin-top:12px"><tr><th>Job</th><th>Started</th><th>From</th><th>Result</th></tr>${jobs
            .map((j) => {
              const result =
                j.endedAt === null
                  ? d.running?.id === j.id
                    ? badge("warn", "running")
                    : badge("muted", "unknown")
                  : j.exitCode === 0
                    ? badge("ok", "done")
                    : badge("bad", `exit ${j.exitCode}`);
              return `<tr><td><a href="/jobs/${esc(j.id)}">${esc(j.label)}</a></td><td>${when(j.startedAt)}</td><td>${esc(j.via)}</td><td>${result}</td></tr>`;
            })
            .join("")}</table>`
        : ""
    }
  </section>`;
}

function traceList(item: ItemTrace & { dry?: boolean }): string {
  const lines = [
    item.rule ? `rule “${esc(item.rule)}”${item.gcpAccount ? ` · GCP account ${esc(item.gcpAccount)}` : ""}` : null,
    ...item.actions.map(
      (a) => `<span class="${a.ok ? "ok" : "bad"}">${a.ok ? "✓" : "✗"}</span> ${esc(a.what)}${a.detail ? ` — <span class="muted">${esc(a.detail)}</span>` : ""}`,
    ),
    ...item.reasons.map((r) => `<span class="warn">!</span> ${esc(r)}`),
  ].filter(Boolean);
  return lines.length ? `<ul class="trace">${lines.map((l) => `<li>${l}</li>`).join("")}</ul>` : "";
}

const outcomeBadge = (o: ItemTrace["outcome"]): string =>
  o === "complete" ? badge("ok", "complete") : o === "dry" ? badge("muted", "dry run") : badge("warn", "needs you");

function itemsTable(items: (ItemTrace & { dry?: boolean })[]): string {
  return `<table><tr><th>Charge</th><th class="num">Amount</th><th>Date</th><th>Missing</th><th>What happened</th><th>Result</th></tr>${items
    .map(
      (i) => `<tr><td class="row-title">${esc(i.supplier ?? "(no supplier)")}</td><td class="num">${money(i.amount, i.currency)}</td>
        <td class="nowrap">${esc(i.paidAt)}<br>${fuse(i.hoursRemaining)}</td><td>${esc(i.needs.join(", "))}</td>
        <td>${traceList(i) || `<span class="muted">—</span>`}</td><td>${outcomeBadge(i.outcome)}</td></tr>`,
    )
    .join("")}</table>`;
}

function lastRun(d: DashboardData): string {
  const run = d.runs.find((r) => r.items.length);
  if (!run)
    return `<section><h2>Last run</h2><p class="muted">No per-charge record yet — runs log one from now on.</p></section>`;
  return `<section><h2>Last run that touched a charge <span class="muted">${esc(run.kind)} · ${when(run.startedAt)} · ${esc(run.summary)}</span></h2>
    ${itemsTable(run.items)}</section>`;
}

function history(d: DashboardData): string {
  const tone = { ok: "ok", attention: "warn", crash: "bad", incomplete: "muted" } as const;
  const rows = d.runs
    .map((r) => {
      const extra = [
        r.blockWarning ? badge("bad", "block warning") : "",
        r.digest ? `<span class="muted">email: ${r.digest.items} item(s)</span>` : "",
      ].join(" ");
      const summary = r.items.length
        ? `<details><summary>${esc(r.summary)}</summary>${itemsTable(r.items)}</details>`
        : esc(r.summary);
      return `<tr><td class="nowrap">${esc(new Date(r.startedAt).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }))}</td>
        <td>${esc(r.kind)}</td><td>${badge(tone[r.status], r.status)}</td><td>${summary} ${extra}</td></tr>`;
    })
    .join("");
  return `<section><h2>History <span class="muted">from logs/runs.jsonl</span></h2>
    <table><tr><th>Started</th><th>Kind</th><th>Status</th><th>Summary</th></tr>${rows}</table></section>`;
}

function invoices(d: DashboardData): string {
  const rows = d.invoices
    .map(
      (f) => `<tr><td><a href="/invoices/${encodeURIComponent(f.name)}" target="_blank" rel="noopener">${esc(f.name)}</a></td>
        <td class="num">${esc((f.bytes / 1024).toFixed(0))} KB</td><td>${when(f.modified)}</td>
        <td>${f.attachedTo ? `${esc(f.attachedTo.supplier ?? "(no supplier)")} · ${money(f.attachedTo.amount, f.attachedTo.currency)} · ${when(f.attachedTo.at)}` : `<span class="muted">not recorded as attached</span>`}</td></tr>`,
    )
    .join("");
  return `<section><h2>Invoices downloaded <span class="muted">latest ${d.invoices.length} in invoices/ — each was checked for the charged amount before being kept</span></h2>
    <table><tr><th>File</th><th class="num">Size</th><th>Downloaded</th><th>Attached to</th></tr>${rows}</table></section>`;
}

function rulesSection(d: DashboardData): string {
  const rows = d.rules
    .map(
      (r, i) => `<tr><td class="num muted">${i + 1}</td><td class="row-title">${esc(r.name)}</td>
        <td>${r.when.map((w) => `<code>${esc(w)}</code>`).join("<br>")}</td>
        <td>${r.then.map(esc).join("<br>")}${r.description ? `<br><span class="muted">“${esc(r.description)}”</span>` : ""}</td>
        <td>${r.invoice ? badge("ok", r.invoice) : `<span class="muted">—</span>`}</td>
        <td class="num">${r.matched || `<span class="muted">0</span>`}</td></tr>`,
    )
    .join("");
  const defaults = Object.entries(d.defaults)
    .map(([k, v]) => `${esc(k)} = <b>${esc(v)}</b>`)
    .join(" · ");
  return `<section><h2>Rules <span class="muted">config/rules.ts — first match wins, anything unmatched is escalated</span></h2>
    <table><tr><th></th><th>Rule</th><th>When</th><th>Then</th><th>Invoice</th><th class="num">Charges, 30 d</th></tr>${rows}</table>
    <p class="muted" style="margin:10px 0 0">Always filled: ${defaults}. Edit the file, then “Check rules” to validate it against Spendesk.</p></section>`;
}

// ------------------------------------------------------------------------ fragments

export function queueFragment(v: QueueView): string {
  const head = `<p class="muted" style="margin:0 0 8px">${v.rows.length} incomplete · ${v.complete} complete, waiting for export · read ${esc(ago(v.at))}</p>`;
  if (!v.rows.length) return `${head}<p>Nothing incomplete in the payables view.</p>`;
  const tone = { auto: "ok", ask: "warn", resolve: "muted", unknown: "bad" } as const;
  const label = { auto: "automatic", ask: "asks you", resolve: "lookup", unknown: "no rule" } as const;
  return `${head}<table><tr><th>Charge</th><th class="num">Amount</th><th>Date</th><th>Missing</th><th>What a run would do</th></tr>${v.rows
    .map(
      ({ item, plan, planKind }) => `<tr><td class="row-title">${esc(item.supplier ?? "(no supplier)")}</td>
        <td class="num">${money(item.amount, item.currency)}</td><td class="nowrap">${esc(item.paidAt)}<br>${fuse(item.hoursRemaining)}</td>
        <td>${esc(item.needs.map((n) => (n.kind === "field" ? n.label : n.kind)).join(", "))}</td>
        <td>${badge(tone[planKind], label[planKind])} ${esc(plan)}</td></tr>`,
    )
    .join("")}</table>`;
}

export const errorFragment = (message: string): string =>
  `<p class="bad">Could not read the queue: ${esc(message)}</p><p class="muted">The public API key in .spendesk-api may need attention.</p>`;

// -------------------------------------------------------------------------- job page

/** A run prints something at least every minute or two; five silent minutes means stuck. */
const QUIET_MINUTES = 5;

export function jobPage(job: Job, output: string, running: boolean, lastOutput: string | null = null): string {
  const quiet = running && lastOutput !== null && Date.now() - new Date(lastOutput).getTime() > QUIET_MINUTES * 6e4;
  const status = running
    ? badge("warn", "running")
    : job.endedAt === null
      ? badge("muted", "unknown")
      : job.exitCode === 0
        ? badge("ok", "done")
        : badge("bad", `exit ${job.exitCode}`);
  return shell(
    `${job.label} — Spendesk automation`,
    `<header><h1>${esc(job.label)}</h1>${status}<a href="/">← dashboard</a></header>
     <section><p class="muted" style="margin:0 0 10px">started ${when(job.startedAt)} from ${esc(job.via)}${
       job.endedAt ? ` · finished ${when(job.endedAt)}` : ""
     }${running ? " · this page refreshes itself" : ""}</p>
     ${
       quiet
         ? `<div class="alert warn">No output for ${esc(ago(lastOutput).replace(" ago", ""))} — this job is probably stuck.
              Stop it with <code>kill ${esc(job.pid)}</code>, then start it again from the dashboard.</div>`
         : ""
     }
     <pre>${esc(output) || "(no output yet)"}</pre></section>`,
    { refreshSeconds: running ? 2 : undefined },
  );
}

export const messagePage = (title: string, message: string): string =>
  shell(title, `<section><h2>${esc(title)}</h2><p>${message}</p><p><a href="/">← dashboard</a></p></section>`);
