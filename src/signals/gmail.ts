// Spendesk's own notification emails, which are the best signals we have.
//
// They need no Spendesk session, which is the whole point: the common question — "does
// anything need me?" — must be answerable without a login (REDESIGN.md §3). And the block
// warning is Spendesk stating the deadline outright, rather than us inferring a 72h fuse.
//
// Read-only, and deliberately fail-soft: a Gmail problem must never be the reason a
// Spendesk run dies.
import { z } from "zod";
import * as log from "../log.ts";

const HOME = process.env.HOME ?? "";

/**
 * gws is installed under fnm, and the `gws` on an interactive PATH lives in
 * ~/.local/state/fnm_multishells/<pid>_<timestamp>/bin — one of thousands of per-shell
 * directories that do not exist for a launchd job. Resolve the durable location instead,
 * newest node version first so a node upgrade doesn't break it.
 */
export function resolveGws(): { bin: string; nodeBin: string } | null {
  const roots = [`${HOME}/.local/share/fnm/node-versions`];
  const found: { bin: string; nodeBin: string; version: string }[] = [];
  for (const root of roots) {
    let entries: string[] = [];
    try {
      entries = [...new Bun.Glob("*/installation/bin/gws").scanSync({ cwd: root, onlyFiles: false })];
    } catch { continue; }
    for (const rel of entries) {
      const bin = `${root}/${rel}`;
      found.push({ bin, nodeBin: bin.replace(/\/gws$/, ""), version: rel.split("/")[0] ?? "" });
    }
  }
  found.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
  return found[0] ?? null;
}

const ListResponse = z.object({
  messages: z.array(z.object({ id: z.string() })).optional().default([]),
});
const MessageResponse = z.object({
  payload: z.object({
    headers: z.array(z.object({ name: z.string(), value: z.string() })).optional().default([]),
  }).optional().default({ headers: [] }),
});

/** gws prints a "Using keyring backend: …" preamble before its JSON. */
function parseJson(stdout: string): unknown {
  const start = stdout.indexOf("{");
  if (start < 0) throw new Error(`no JSON in gws output: ${stdout.slice(0, 120)}`);
  return JSON.parse(stdout.slice(start));
}

async function gws(args: string[]): Promise<unknown> {
  const found = resolveGws();
  if (!found) throw new Error("gws not found under ~/.local/share/fnm/node-versions");
  const proc = Bun.spawn([found.bin, ...args], {
    // gws is a node script: node must be on PATH, and launchd's PATH will not have it.
    env: { ...process.env, PATH: `${found.nodeBin}:${process.env.PATH ?? ""}` },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  if ((await proc.exited) !== 0) throw new Error(`gws failed: ${(err || out).slice(0, 200)}`);
  return parseJson(out);
}

// ------------------------------------------------------------------ the signals

export type Signal =
  | { kind: "purchase"; at: Date; amount: number; currency: string; subscription: boolean; subject: string }
  | { kind: "block-warning"; at: Date; subject: string }
  | { kind: "declined"; at: Date; amount: number; currency: string; subject: string };

const AMOUNT = /([€$])\s?([\d]{1,3}(?:[   ,.]\d{3})*(?:[.,]\d{2})?)/;

/** "€1 234,56" and "€1,234.56" both occur; normalise to a number. */
export function parseAmount(subject: string): { amount: number; currency: string } | null {
  const m = AMOUNT.exec(subject);
  if (!m) return null;
  const raw = m[2]!.replace(/[   ]/g, "");
  // last separator is the decimal one
  const norm = /,\d{2}$/.test(raw) ? raw.replace(/\./g, "").replace(",", ".") : raw.replace(/,/g, "");
  const amount = Number(norm);
  return Number.isFinite(amount) ? { amount, currency: m[1] === "€" ? "EUR" : "USD" } : null;
}

export function classify(subject: string, at: Date): Signal | null {
  if (/will be blocked in 24h/i.test(subject)) return { kind: "block-warning", at, subject };

  const money = parseAmount(subject);
  if (!money) return null;

  if (/was declined/i.test(subject)) return { kind: "declined", at, ...money, subject };
  if (/for your subscription/i.test(subject))
    return { kind: "purchase", at, ...money, subscription: true, subject };
  if (/New purchase of/i.test(subject))
    return { kind: "purchase", at, ...money, subscription: false, subject };
  return null;
}

/**
 * Recent Spendesk signals. Never throws: on any failure it logs and returns an empty list,
 * because a Gmail outage must degrade the run, not stop it.
 */
export async function readSignals({ days = 7 }: { days?: number } = {}): Promise<Signal[]> {
  try {
    const list = ListResponse.parse(
      await gws(["gmail", "users", "messages", "list", "--params",
        JSON.stringify({ userId: "me", q: `from:spendesk newer_than:${days}d`, maxResults: 100 })]),
    );

    const out: Signal[] = [];
    for (const { id } of list.messages) {
      const msg = MessageResponse.parse(
        await gws(["gmail", "users", "messages", "get", "--params",
          JSON.stringify({ userId: "me", id, format: "metadata", metadataHeaders: ["Subject", "Date"] })]),
      );
      const h = Object.fromEntries(msg.payload.headers.map((x) => [x.name.toLowerCase(), x.value]));
      const subject = h["subject"] ?? "";
      const at = new Date(h["date"] ?? Date.now());
      const signal = classify(subject, at);
      if (signal) out.push(signal);
    }
    return out.sort((a, b) => b.at.getTime() - a.at.getTime());
  } catch (e) {
    log.warn(`Gmail signals unavailable: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

/** Is Spendesk telling us the card is about to be blocked? Its word beats our arithmetic. */
export function blockWarning(signals: Signal[]): Signal | null {
  const cutoff = Date.now() - 36 * 36e5; // the warning gives 24h; allow slack for a late run
  return signals.find((s) => s.kind === "block-warning" && s.at.getTime() > cutoff) ?? null;
}
