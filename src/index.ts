#!/usr/bin/env bun
// Spendesk expense automation.
//
//   bun run run          the daily job
//   bun run dry          decide everything, write nothing
//   bun run check        session + rules validity; exit 1 if broken
//   bun run go           sign in, then run — what the emailed link triggers
//   bun run serve        the listener behind that link
//   bun run reauth       explainer -> sign in -> success
//   bun run rules:check  resolve every label against the live schema
//   bun run fetch gcp --amount 266.49
//
// `--dry` is the development and debugging mode. The scheduled job runs without it, by
// design: a confirm step reintroduces exactly the latency that blocks the card (DESIGN §1).
import { defaults, rules, me } from "./config.ts";
import { loadSchema, resolveMember, validateRules } from "./spendesk/schema.ts";
import { requiredFields } from "./rules.ts";
import { sessionAlive } from "./spendesk/auth.ts";
import { closeQuietly, openContext } from "./browser.ts";
import { adapterFor, fetchInvoice, isVendor, VENDORS } from "./vendors/index.ts";
import { reauth } from "./reauth.ts";
import { runDaily } from "./run.ts";
import { serve } from "./trigger.ts";
import { describeSchedule, schedule, unschedule } from "./schedule.ts";
import { readSignals, blockWarning } from "./signals/index.ts";
import * as log from "./log.ts";

const argv = Bun.argv.slice(2);
const command = argv[0] ?? "run";
const DRY = argv.includes("--dry");

// --------------------------------------------------------------------------- go
/**
 * What the emailed link triggers: sign in, then finish the run.
 *
 * Kept as one command so the listener has nothing to orchestrate — and so the sequence is
 * identical whether it was reached from an email or typed by hand.
 */
async function cmdGo(): Promise<void> {
  const signedIn = await reauth({});
  if (!signedIn) {
    // Not an error: the window may simply have been closed. The digest already said what
    // was waiting, and the next run will offer the link again.
    log.warn("sign-in did not complete — nothing was changed");
    return;
  }
  await runDaily({ dry: false });
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

  // Deliberately first, and deliberately session-free. "Do I need to do something?" is the
  // question asked most often, and needing to log in to answer it is the original problem
  // (REDESIGN §3). The emails answer it with no Spendesk session at all.
  try {
    const { signals, source } = await readSignals({ days: 3 });
    if (signals === null) {
      // The only source could not be read. Reporting "no block warning" here would be a
      // guess dressed as an all-clear, which is the failure this command exists to prevent.
      log.fail(`could not read the notification emails (${source}) — cannot say whether anything needs you`);
      bad = true;
    } else {
      const warning = blockWarning(signals);
      const declined = signals.filter((s) => s.kind === "declined");
      const purchases = signals.filter((s) => s.kind === "purchase");

      if (warning) {
        log.fail(`Spendesk says the card is about to be blocked: "${warning.subject}"`);
        bad = true;
      }
      for (const d of declined) {
        log.fail(`payment of ${d.amount.toFixed(2)} ${d.currency} declined (${d.at.toISOString().slice(0, 16)})`);
        bad = true;
      }
      if (!warning && !declined.length) {
        log.ok(`no block warning in the last 36h (${purchases.length} purchase email(s) in 3 days, via ${source})`);
      }
    }
  } catch (e) {
    log.fail(`email signals unavailable: ${e instanceof Error ? e.message : String(e)}`);
    bad = true;
  }

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
  go: cmdGo,
  // Bun.serve holds the event loop open by itself; the never-resolving promise just makes
  // that explicit, so the process cannot be exited by the dispatcher finishing.
  serve: async () => {
    serve();
    await new Promise<void>(() => {});
  },
  reauth: async () => {
    await reauth({ force: argv.includes("--force") });
  },
  "rules:check": cmdRulesCheck,
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
