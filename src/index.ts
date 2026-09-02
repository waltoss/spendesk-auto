#!/usr/bin/env bun
// Spendesk expense automation.
//
//   bun run run          the daily job
//   bun run dry          decide everything, write nothing
//   bun run check        session + rules validity; exit 1 if broken
//   bun run reauth       explainer -> sign in -> success
//   bun run rules:check  resolve every label against the live schema
//   bun run fetch gcp --amount 266.49
//
// `--dry` is the development and debugging mode. The scheduled job runs without it, by
// design: a confirm step reintroduces exactly the latency that blocks the card (DESIGN §1).
import { defaults, rules, me } from "./config.ts";
import { loadSchema, resolveMember, validateRules } from "./spendesk/schema.ts";
import { requiredFields } from "./rules.ts";
import { sessionAlive, keepWarm } from "./spendesk/auth.ts";
import { closeQuietly, openContext } from "./browser.ts";
import { adapterFor, fetchInvoice, isVendor, VENDORS } from "./vendors/index.ts";
import { reauth } from "./reauth.ts";
import { runDaily } from "./run.ts";
import { describeSchedule, schedule, unschedule } from "./schedule.ts";
import * as log from "./log.ts";

const argv = Bun.argv.slice(2);
const command = argv[0] ?? "run";
const DRY = argv.includes("--dry");

// ----------------------------------------------------------------------- keep-warm

/**
 * Ping the session so it never goes cold. Scheduled every 30 minutes.
 *
 * Deliberately silent and cheap: one request, no browser page, no writes. It records the
 * gap since the previous successful ping, so `logs/runs.jsonl` accumulates the evidence
 * for how long the session really holds — the number that should set the interval.
 */
async function cmdKeepWarm(): Promise<void> {
  const context = await openContext({ headless: true });
  try {
    const previous = log.lastEvent("warm");
    const gapMin = previous ? (Date.now() - new Date(previous.at).getTime()) / 6e4 : null;

    const { alive, status } = await keepWarm(context);
    if (alive) {
      log.ok(`session warm${gapMin === null ? "" : ` (held ${gapMin.toFixed(0)} min since last ping)`}`);
      log.record("warm", { gapMin: gapMin === null ? null : Math.round(gapMin) });
    } else {
      // Worth an explicit line: the whole point is to notice the moment it stops working.
      log.fail(`session went cold${gapMin === null ? "" : ` after ${gapMin.toFixed(0)} min`} (HTTP ${status}) — run: bun run reauth`);
      log.record("went-cold", { gapMin: gapMin === null ? null : Math.round(gapMin), status });
      process.exitCode = 1;
    }
  } finally {
    await closeQuietly(context);
  }
}

// --------------------------------------------------------------------- rules:check

async function cmdRulesCheck(): Promise<void> {
  const [schema, member] = await Promise.all([loadSchema(), resolveMember(me.email)]);
  log.say(`member : ${member.name} (${member.id})`);
  log.say(`schema : ${schema.fields.size} analytical fields`);

  const problems = validateRules({ schema, defaults, rules });

  log.head("required on every payable");
  for (const label of requiredFields({ defaults, rules })) log.step(label);

  log.head("rules");
  for (const rule of rules) {
    const bits = Object.entries(rule.fields ?? {}).map(
      ([k, v]) => `${k.split(")").pop()?.trim().slice(0, 24) ?? k}=${v}`,
    );
    if (rule.ask) bits.push(`asks: "${rule.ask.question}"`);
    if (rule.invoice) bits.push(`invoice:${rule.invoice}`);
    log.step(`${rule.name.padEnd(30)} ${bits.join("  ")}`);
  }

  log.say();
  if (problems.length) {
    problems.forEach((p) => log.fail(p));
    process.exitCode = 1;
    return;
  }
  log.ok("all rules resolve against the live Spendesk schema");
}

// --------------------------------------------------------------------------- check

async function cmdCheck(): Promise<void> {
  let bad = false;

  try {
    const [schema, member] = await Promise.all([loadSchema(), resolveMember(me.email)]);
    const problems = validateRules({ schema, defaults, rules });
    if (problems.length) {
      problems.forEach(log.fail);
      bad = true;
    } else log.ok(`public API + rules valid (${member.name})`);
  } catch (e) {
    log.fail(`public API: ${e instanceof Error ? e.message : String(e)}`);
    bad = true;
  }

  const context = await openContext({ headless: true });
  try {
    const alive = await sessionAlive(context);
    const lastOk = log.lastEvent("session-alive");
    const days = lastOk ? ((Date.now() - new Date(lastOk.at).getTime()) / 864e5).toFixed(1) : null;
    if (alive) {
      log.ok("browser session alive");
      log.record("session-alive", {});
    } else {
      log.fail(`browser session dead${days ? ` — last alive ${days} days ago` : ""}; run: bun run reauth`);
      log.record("session-dead", { daysSinceAlive: days ? Number(days) : null });
      bad = true;
    }
  } finally {
    await closeQuietly(context);
  }

  process.exitCode = bad ? 1 : 0;
}

// --------------------------------------------------------------------------- fetch

// Exercise one vendor adapter on its own. Retrieval is the part that can fail silently,
// and it is only reachable through `run` when a matching payable happens to be waiting —
// so it needs a way to be tested against a charge you already know about.
//
//   bun run fetch gcp --amount 266.49 --currency EUR
//   bun run fetch gcp                     # just list what is there
async function cmdFetch(): Promise<void> {
  const vendor = argv[1];
  if (!vendor || !isVendor(vendor))
    throw new Error(`usage: fetch <${VENDORS.join("|")}> [--amount N] [--currency EUR]`);

  const flag = (name: string): string | null => {
    const i = argv.indexOf(`--${name}`);
    return i > -1 ? (argv[i + 1] ?? null) : null;
  };
  const rawAmount = flag("amount");
  const amount = rawAmount === null ? null : Number(rawAmount);
  const currency = flag("currency") ?? "EUR";
  const headless = !argv.includes("--headed");

  const context = await openContext({ headless });
  try {
    const adapter = adapterFor(vendor);
    const page = await context.newPage();
    if (await adapter.loggedOut(page)) throw new Error(`not signed in to ${vendor} — rerun with --headed and sign in`);

    const entries = await adapter.list(page);
    log.head(`${entries.length} invoice(s) at ${vendor}`);
    for (const e of entries)
      log.step(
        `${(e.account ?? "").padEnd(22)} ${(e.date ?? "?").padEnd(18)} ${String(e.amount ?? "?").padStart(10)} ${e.currency ?? ""}`,
      );
    await page.close().catch(() => {});

    if (amount === null) return;

    const got = await fetchInvoice(context, vendor, { amount, currency }, { entries });
    log.say();
    if (!got.ok) {
      log.fail(got.error);
      process.exitCode = 1;
    } else log.ok(`verified ${got.value.file}`);
  } finally {
    await closeQuietly(context);
  }
}

// ---------------------------------------------------------------------------- main

const commands: Record<string, () => Promise<void>> = {
  run: async () => {
    await runDaily({ dry: DRY });
  },
  fetch: cmdFetch,
  check: cmdCheck,
  reauth: async () => {
    await reauth({ force: argv.includes("--force") });
  },
  "rules:check": cmdRulesCheck,
  "keep-warm": cmdKeepWarm,
  schedule,
  unschedule,
  "schedule:show": describeSchedule,
};

const fn = commands[command];
if (!fn) {
  log.fail(`unknown command "${command}" — try: ${Object.keys(commands).join(", ")}`);
  process.exit(2);
}
try {
  await fn();
} catch (e) {
  const message = e instanceof Error ? e.message : String(e);
  log.fail(message);
  log.record("crash", { command, message });
  process.exit(1);
}
