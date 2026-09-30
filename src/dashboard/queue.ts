// "What does it see right now?" — the payables view, read through the public API.
//
// Public API only, on purpose: it needs no Spendesk session and no browser, so the page can
// load it while a run holds the Chrome profile, and while the session is dead — which is
// exactly when you most want to look. The cost is the payables view's ~2-day lag; charges
// younger than that show up under the last run instead, which saw them via payments.
import { defaults, rules, me } from "../config.ts";
import { resolveMember } from "../spendesk/schema.ts";
import { listIncompletePayables } from "../spendesk/queue.ts";
import { match, requiredFields } from "../rules.ts";
import type { PayableItem } from "../types.ts";

export interface QueueRow {
  item: PayableItem;
  /** What the daily run would do, in words — the matcher's decision, without any writes. */
  plan: string;
  planKind: "auto" | "ask" | "resolve" | "unknown";
}

export interface QueueView {
  at: string;
  rows: QueueRow[];
  complete: number;
}

const CACHE_MS = 60_000;
let cache: { at: number; view: Promise<QueueView> } | null = null;

export function queueView({ refresh = false } = {}): Promise<QueueView> {
  if (!refresh && cache && Date.now() - cache.at < CACHE_MS) return cache.view;
  const view = load();
  cache = { at: Date.now(), view };
  // A failure must not be cached for a minute: the next load should try again.
  view.catch(() => {
    cache = null;
  });
  return view;
}

async function load(): Promise<QueueView> {
  const member = await resolveMember(me.email);
  const all = await listIncompletePayables({ memberId: member.id, requiredFields: requiredFields({ defaults, rules }) });
  const incomplete = all.filter((p) => p.completionState !== "complete");
  return {
    at: new Date().toISOString(),
    complete: all.length - incomplete.length,
    rows: incomplete
      .sort((a, b) => (a.hoursRemaining ?? Infinity) - (b.hoursRemaining ?? Infinity))
      .map((item) => ({ item, ...plan(item) })),
  };
}

function plan(item: PayableItem): Pick<QueueRow, "plan" | "planKind"> {
  const d = match(item, { defaults, rules });
  switch (d.kind) {
    case "auto": {
      const parts = [`rule “${d.rule.name}”`];
      const missing = new Set(item.needs.map((n) => (n.kind === "field" ? n.label.trim() : n.kind)));
      const fields = Object.entries(d.fields).filter(([label]) => missing.has(label.trim()));
      if (fields.length) parts.push(`set ${fields.map(([k, v]) => `${k.split(")").pop()?.trim()}=${v}`).join(", ")}`);
      if (missing.has("description") && d.description) parts.push(`description “${d.description}” (needs a session)`);
      if (missing.has("receipt")) parts.push(d.invoice ? `fetch invoice from ${d.invoice}` : "no invoice adapter — escalate");
      return { planKind: "auto", plan: parts.join(" · ") };
    }
    case "ask":
      return { planKind: "ask", plan: `rule “${d.rule.name}” — asks you: “${d.question}”` };
    case "resolve":
      return {
        planKind: "resolve",
        plan: `look up the GCP billing account, then one of: ${d.candidates.map((r) => r.name).join(", ")}`,
      };
    case "unknown":
      return { planKind: "unknown", plan: d.note ?? "no rule matches — escalated" };
  }
}
