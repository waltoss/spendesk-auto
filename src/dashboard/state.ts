// What the dashboard knows without asking anyone: the run ledger, the invoices folder and
// the rules file.
//
// Loading the page must never probe a live site. A Google sign-in check is a full page
// load, and polling payments.google.com is what got this account rate-limited once
// (DESIGN §10); a dashboard left open in a tab would do exactly that. So every status here
// is "last known, and when" — a live check is a button, run as a job.
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { RunEvent } from "../log.ts";
import type { ItemTrace, Rule } from "../types.ts";

/** The Spendesk session is good for about an hour after it was last confirmed (DESIGN §8.3). */
export const SPENDESK_SESSION_MINUTES = 60;

const ms = (iso: string): number => new Date(iso).getTime();

// ------------------------------------------------------------------------- sign-ins

export interface SignIn {
  name: string;
  /** "alive" only when recent enough to still be true; otherwise what we last saw. */
  state: "alive" | "stale" | "dead" | "unknown";
  lastAlive: string | null;
  lastDead: string | null;
  note: string;
}

export function spendeskSignIn(events: RunEvent[], now = Date.now()): SignIn {
  const lastAlive = findLast(events, (e) => e.event === "session-alive")?.at ?? null;
  const lastDead = findLast(events, (e) => e.event === "session-dead")?.at ?? null;
  const base = { name: "Spendesk", lastAlive, lastDead };
  if (!lastAlive && !lastDead) return { ...base, state: "unknown", note: "never checked" };
  if (lastDead && (!lastAlive || ms(lastDead) > ms(lastAlive)))
    return { ...base, state: "dead", note: "signed out — descriptions cannot be written" };
  const minutes = (now - ms(lastAlive!)) / 6e4;
  return minutes <= SPENDESK_SESSION_MINUTES
    ? { ...base, state: "alive", note: "signed in" }
    : { ...base, state: "stale", note: `probably expired — sessions last about ${SPENDESK_SESSION_MINUTES} min` };
}

/**
 * Vendor sessions last months, so the evidence is sparser: a sign-in probe during reauth
 * ("vendor-status"), a failed invoice fetch ("vendor-signed-out"), or a successful one.
 */
export function vendorSignIn(events: RunEvent[], name: string, adapter: string): SignIn {
  let lastAlive: string | null = null;
  let lastDead: string | null = null;
  for (const e of events) {
    const isThis = String(e["vendor"] ?? "").toLowerCase() === name.toLowerCase() || e["vendor"] === adapter;
    if (e.event === "vendor-status" && isThis) {
      if (e["alive"]) lastAlive = e.at;
      else lastDead = e.at;
    } else if (e.event === "vendor-signed-out" && isThis) lastDead = e.at;
    else if (e.event === "vendors-checked") lastAlive = e.at;
    else if (e.event === "item") {
      const fetched = (e["actions"] as ItemTrace["actions"] | undefined)?.some(
        (a) => a.ok && a.what === `attach invoice (${adapter})`,
      );
      if (fetched) lastAlive = e.at;
    }
  }
  const base = { name, lastAlive, lastDead };
  if (!lastAlive && !lastDead) return { ...base, state: "unknown", note: "no record yet" };
  if (lastDead && (!lastAlive || ms(lastDead) > ms(lastAlive))) return { ...base, state: "dead", note: "signed out" };
  return { ...base, state: "alive", note: "signed in when last checked" };
}

// ----------------------------------------------------------------------------- runs

export interface RunRow {
  runId: string;
  startedAt: string;
  kind: "run" | "dry run" | "sign-in" | "check" | "other";
  status: "ok" | "attention" | "crash" | "incomplete";
  summary: string;
  items: (ItemTrace & { at: string; dry: boolean })[];
  digest: { items: number; notes: number } | null;
  blockWarning: boolean;
}

/**
 * One row per process. `runId` is the process's start time, so it doubles as the start.
 * The listener is a process too, and a long-lived one: its "trigger"/"job" events are
 * clicks, not runs, and are left out rather than shown as one run spanning weeks.
 */
export function runRows(events: RunEvent[], limit = 40): RunRow[] {
  const groups = new Map<string, RunEvent[]>();
  for (const e of events) {
    if (e.event === "trigger" || e.event === "job") continue;
    const list = groups.get(e.runId) ?? [];
    list.push(e);
    groups.set(e.runId, list);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => ms(b) - ms(a))
    .slice(0, limit)
    .map(([runId, list]) => row(runId, list));
}

function row(runId: string, list: RunEvent[]): RunRow {
  const run = findLast(list, (e) => e.event === "run");
  const crash = findLast(list, (e) => e.event === "crash");
  const digest = findLast(list, (e) => e.event === "digest");
  const items = list
    .filter((e) => e.event === "item")
    .map((e) => ({ ...(e as unknown as ItemTrace), at: e.at, dry: Boolean(e["dry"]) }));
  const reauthed = list.some((e) => e.event === "session-alive" && e["via"] === "reauth");

  // A crash names its command; the rest is inferred from what the process got to log.
  const byCommand: Record<string, RunRow["kind"]> = { run: "run", go: "sign-in", reauth: "sign-in", check: "check" };
  const crashed = crash ? byCommand[String(crash["command"])] : undefined;
  const kind: RunRow["kind"] = crashed
    ? crashed
    : run
    ? run["dry"]
      ? "dry run"
      : "run"
    : reauthed || list.some((e) => e.event === "vendors-checked" || e.event === "vendor-status")
      ? "sign-in"
      : list.every((e) => e.event.startsWith("session-"))
        ? "check"
        : "other";

  let status: RunRow["status"];
  let summary: string;
  if (crash) {
    status = "crash";
    summary = String(crash["message"] ?? "crashed").split("\n")[0]!.slice(0, 200);
  } else if (run) {
    const escalations = Number(run["escalations"] ?? 0);
    const done = Number(run["done"] ?? 0);
    const incomplete = Number(run["incomplete"] ?? 0);
    status = escalations ? "attention" : "ok";
    summary = incomplete
      ? `${incomplete} incomplete · ${done} completed · ${escalations} need you · via ${String(run["via"] ?? "?")}`
      : "nothing to do";
  } else if (reauthed) {
    status = "ok";
    summary = "signed in";
  } else if (kind === "check") {
    status = list.some((e) => e.event === "session-dead") ? "attention" : "ok";
    summary = status === "ok" ? "session alive" : "session dead";
  } else {
    status = "incomplete";
    summary = list.map((e) => e.event).join(", ");
  }

  return {
    runId,
    startedAt: runId,
    kind,
    status,
    summary,
    items,
    digest: digest ? { items: Number(digest["items"] ?? 0), notes: Number(digest["notes"] ?? 0) } : null,
    blockWarning: list.some((e) => e.event === "block-warning"),
  };
}

/** The last time the automation was clicked from an email, and the last card-block warning. */
export function lastOf(events: RunEvent[], event: string): RunEvent | null {
  return findLast(events, (e) => e.event === event) ?? null;
}

// -------------------------------------------------------------------------- invoices

export interface InvoiceFile {
  name: string;
  bytes: number;
  modified: string;
  /** Where a run attached it, when the ledger says so. */
  attachedTo: { supplier: string | null; amount: number; currency: string; at: string } | null;
}

export function invoiceFiles(dir: string, events: RunEvent[], limit = 15): InvoiceFile[] {
  const attached = new Map<string, InvoiceFile["attachedTo"]>();
  for (const e of events) {
    if (e.event !== "item") continue;
    const trace = e as unknown as ItemTrace;
    for (const a of trace.actions ?? [])
      if (a.ok && a.what.startsWith("attach invoice") && a.detail)
        attached.set(a.detail, { supplier: trace.supplier, amount: trace.amount, currency: trace.currency, at: e.at });
  }
  let names: string[];
  try {
    names = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".pdf"));
  } catch {
    return [];
  }
  return names
    .map((name) => {
      const st = statSync(path.join(dir, name));
      return { name, bytes: st.size, modified: st.mtime.toISOString(), attachedTo: attached.get(name) ?? null };
    })
    .sort((a, b) => ms(b.modified) - ms(a.modified))
    .slice(0, limit);
}

/** Only a plain file name that exists in the invoices folder — never a path. */
export const isInvoiceName = (name: string): boolean => /^[\w.\-]+\.pdf$/i.test(name) && !name.startsWith(".");

// ----------------------------------------------------------------------------- rules

export interface RuleRow {
  name: string;
  when: string[];
  then: string[];
  description: string | null;
  invoice: string | null;
  /** How many charges this rule claimed in the last 30 days of runs. */
  matched: number;
}

export function ruleRows(rules: Rule[], events: RunEvent[], now = Date.now()): RuleRow[] {
  const since = now - 30 * 864e5;
  const counts = new Map<string, Set<string>>();
  for (const e of events) {
    if (e.event !== "item" || ms(e.at) < since) continue;
    const trace = e as unknown as ItemTrace;
    if (!trace.rule) continue;
    // The same charge is seen by several runs; count charges, not sightings.
    const seen = counts.get(trace.rule) ?? new Set<string>();
    seen.add(`${trace.amount} ${trace.currency} ${trace.paidAt}`);
    counts.set(trace.rule, seen);
  }

  const month = new Date(now).toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
  return rules.map((rule) => {
    const w = rule.when ?? {};
    const when = [
      w.supplier && `supplier ~ ${w.supplier}`,
      w.description && `description ~ ${w.description}`,
      w.currency && `currency = ${w.currency}`,
      w.amount !== undefined && `amount = ${w.amount}`,
      w.card && `card = ${w.card}`,
      w.gcpAccount && `GCP account = ${w.gcpAccount}`,
    ].filter((x): x is string => Boolean(x));
    const then = rule.ask
      ? [`ask: “${rule.ask.question}”`]
      : Object.entries(rule.fields ?? {}).map(([k, v]) => `${k} = ${v}`);
    const description =
      typeof rule.description === "function"
        ? rule.description({ month, amount: 0, currency: "EUR", date: "", supplier: null })
        : (rule.description ?? null);
    return {
      name: rule.name,
      when: when.length ? when : ["anything"],
      then,
      description,
      invoice: rule.invoice ?? null,
      matched: counts.get(rule.name)?.size ?? 0,
    };
  });
}

// ----------------------------------------------------------------------------- misc

function findLast<T>(list: T[], pred: (x: T) => boolean): T | undefined {
  for (let i = list.length - 1; i >= 0; i--) if (pred(list[i]!)) return list[i];
  return undefined;
}
