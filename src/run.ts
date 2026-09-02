// The daily job: read the queue, decide, write, verify, escalate whatever is left.
//
// Separate from the CLI so it can be called with an explicit `dry` rather than reading a
// process flag — the scheduled job (src/job.ts) is a second caller, and a run mode
// that depends on argv parsing is a run mode that can be got wrong by accident.
//
// A card transaction has a ~3-day fuse and the payable only appears on day 2, so the
// actionable window is ~24h. That is why the mechanical cases are filled autonomously:
// a confirm step reintroduces exactly the latency that blocks the card (DESIGN §1).
import type { BrowserContext } from "playwright";
import { defaults, rules, me } from "./config.ts";
import { loadSchema, resolveMember, validateRules } from "./spendesk/schema.ts";
import { listIncompletePayments, listIncompletePayables } from "./spendesk/queue.ts";
import { match, requiredFields } from "./rules.ts";
import {
  attachReceipt,
  attachReceiptToPayment,
  GuardError,
  paymentIdFor,
  setDescription,
  setFields,
  setPaymentFields,
} from "./spendesk/write.ts";
import { verifyPayable, completionState } from "./spendesk/verify.ts";
import { sessionAlive } from "./spendesk/auth.ts";
import { closeQuietly, openContext } from "./browser.ts";
import { fetchInvoice, resolveGcpAccount } from "./vendors/index.ts";
import { sendDigest } from "./notify.ts";
import type { Escalation, QueueItem } from "./types.ts";
import * as log from "./log.ts";

// The fuse can already have burned through: say so rather than printing "-105h left".
export const hours = (h: number | null | undefined): string => {
  if (h === null || h === undefined) return "unknown time";
  const n = Math.round(h);
  return n >= 0 ? `${n}h left` : `overdue by ${-n}h`;
};

const money = (p: QueueItem): string => `${p.amount.toFixed(2)} ${p.currency}`;

export interface RunSummary {
  done: number;
  escalations: number;
  incomplete: number;
  via: "payments" | "payables";
}

export async function runDaily({ dry }: { dry: boolean }): Promise<RunSummary> {
  const [schema, member] = await Promise.all([loadSchema(), resolveMember(me.email)]);

  // Rules are validated before anything is read, let alone written: a typo in the rules
  // file must fail here, not halfway through a batch.
  const problems = validateRules({ schema, defaults, rules });
  if (problems.length) {
    problems.forEach(log.fail);
    throw new Error("rules do not resolve against the live schema — refusing to run");
  }

  const required = requiredFields({ defaults, rules });

  // Prefer the payment view: it exists from day 0, and Spendesk's own control rules say
  // exactly what is missing. Fall back to payables only when there is no session — that
  // path appears two days late and can only guess at the required fields, but it still
  // writes fields and receipts through the public API.
  const context: BrowserContext = await openContext({ headless: true });
  const sessionOk = await sessionAlive(context);
  log.record(sessionOk ? "session-alive" : "session-dead", {});
  const via = sessionOk ? "payments" : "payables";

  let queue: QueueItem[];
  if (sessionOk) {
    queue = await listIncompletePayments({ context, memberId: member.id, schema });
  } else {
    log.warn("no Spendesk session — falling back to payables (2 days late, descriptions skipped)");
    queue = await listIncompletePayables({ memberId: member.id, requiredFields: required });
  }
  const incomplete = queue.filter((p) => p.completionState !== "complete");

  log.say(
    `${member.name} · ${incomplete.length} incomplete ${sessionOk ? "payment" : "payable"}(s)${dry ? "  (dry run — nothing will be written)" : ""}`,
  );
  if (!incomplete.length) {
    log.ok("nothing to do");
    log.record("run", { dry, incomplete: 0, via });
    await closeQuietly(context);
    return { done: 0, escalations: 0, incomplete: 0, via };
  }

  const escalations: Escalation[] = [];
  const done: QueueItem[] = [];

  try {
    for (const payment of incomplete) {
      log.head(
        `${payment.supplier ?? "(no supplier)"} · ${money(payment)} · ${payment.paidAt} · ${hours(payment.hoursRemaining)}`,
      );
      log.step(`needs: ${payment.needs.map((n) => (n.kind === "field" ? n.label : n.kind)).join(", ")}`);

      let decision = match(payment, { defaults, rules });

      // A GCP payable cannot name its own billing account; payments.google.com can, by
      // amount. Resolve, then match again.
      if (decision.kind === "resolve") {
        if (dry) {
          log.step(
            `would look up the GCP billing account for ${money(payment)} (candidates: ${decision.candidates.map((r) => r.name).join(", ")})`,
          );
          escalations.push({ payment, reason: "GCP billing account not yet resolved (dry run)" });
          continue;
        }
        const account = await resolveGcpAccount(context, payment).catch((e: unknown) => {
          log.warn(`GCP lookup failed: ${e instanceof Error ? e.message : String(e)}`);
          return null;
        });
        if (!account) {
          escalations.push({ payment, reason: "could not tell which GCP billing account this charge belongs to" });
          continue;
        }
        log.step(`GCP billing account ${account}`);
        decision = match(payment, { defaults, rules }, { gcpAccount: account });
      }

      if (decision.kind === "unknown") {
        log.warn(`no rule matches${decision.note ? ` — ${decision.note}` : ""}`);
        escalations.push({ payment, reason: decision.note ?? "no rule matches this supplier" });
        continue;
      }

      if (decision.kind === "ask") {
        log.warn(`needs a human: "${decision.question}"`);
        escalations.push({ payment, reason: decision.question, ask: true, rule: decision.rule });
        continue;
      }

      if (decision.kind === "resolve") {
        // Only reachable if the second match round-tripped back to "resolve", which would
        // mean the account we just found matches no rule. Escalate rather than loop.
        escalations.push({ payment, reason: "the GCP billing account could not be matched to a rule" });
        continue;
      }

      // ------------------------------------------------------------------ fields
      const missing = payment.needs.flatMap((n) => (n.kind === "field" ? [n.label] : []));
      const toSet = Object.fromEntries(
        Object.entries(decision.fields).filter(([label]) => missing.some((m) => m.trim() === label.trim())),
      );
      if (Object.keys(toSet).length) {
        try {
          if (payment.kind === "payment") {
            await setPaymentFields(context, payment.paymentId, toSet, { schema, memberId: member.id, dry });
          } else {
            await setFields(payment.payableId, toSet, {
              schema,
              memberId: member.id,
              expectedSearchState: payment.searchState,
              dry,
            });
          }
          log.ok(
            `${dry ? "would set" : "set"} ${Object.entries(toSet)
              .map(([k, v]) => `${k.split(")").pop()?.trim() ?? k}=${v}`)
              .join(", ")}`,
          );
        } catch (e) {
          const how = e instanceof GuardError ? "guard refused" : "failed";
          const message = e instanceof Error ? e.message : String(e);
          log.fail(`fields ${how}: ${message}`);
          escalations.push({ payment, reason: `could not set fields: ${message}` });
          continue;
        }
      }

      // ------------------------------------------------------------- description
      if (payment.needs.some((n) => n.kind === "description") && decision.description) {
        if (dry) {
          log.ok(`would set description "${decision.description}"`);
        } else if (!sessionOk) {
          escalations.push({ payment, reason: "description needs a Spendesk session — please re-authenticate" });
        } else {
          // A payment knows its own id; a payable has to be joined back to one.
          const paymentId = await paymentIdFor(context, payment, { memberId: member.id });
          if (!paymentId) {
            log.fail("could not join this payable to its payment id");
            escalations.push({
              payment,
              reason: "could not identify the payment behind this payable, so the description was not written",
            });
          } else {
            await setDescription(context, paymentId, decision.description, { dry });
            log.ok(`description "${decision.description}"`);
          }
        }
      }

      // ----------------------------------------------------------------- receipt
      if (payment.needs.some((n) => n.kind === "receipt")) {
        if (!decision.invoice) {
          log.warn("no receipt and no vendor adapter to fetch one");
          escalations.push({ payment, reason: "the receipt is missing and cannot be fetched automatically" });
        } else if (dry) {
          log.ok(`would fetch the invoice from ${decision.invoice} and attach it`);
        } else {
          const got = await fetchInvoice(context, decision.invoice, payment);
          if (!got.ok) {
            log.fail(`invoice: ${got.error}`);
            escalations.push({ payment, reason: `could not retrieve the invoice: ${got.error}` });
          } else {
            if (payment.kind === "payment")
              await attachReceiptToPayment(context, payment.paymentId, got.value.file, { dry });
            else await attachReceipt(payment.payableId, got.value.file, { dry });
            log.ok(`attached ${got.value.file.split("/").pop()}`);
          }
        }
      }

      // ------------------------------------------------------------------ verify
      // Never model completeness — ask. Spendesk's control rules are the authority and
      // they disagree with any offline approximation (they required nothing at all on one
      // GCP payment and two fields on another).
      if (!dry) {
        const paymentId = sessionOk ? await paymentIdFor(context, payment, { memberId: member.id }) : null;
        const state = paymentId && sessionOk ? await completionState(context, paymentId).catch(() => null) : null;

        if (state === "complete") {
          log.ok("verified complete (Spendesk agrees)");
          done.push(payment);
        } else if (state) {
          log.warn(`Spendesk still says "${state}"`);
          escalations.push({ payment, reason: `Spendesk still considers this incomplete ("${state}")` });
        } else if (payment.kind === "payable") {
          // No session: fall back to what the public API can see.
          const v = await verifyPayable(payment.payableId, { requiredFields: required });
          const still = [
            ...v.missingFields,
            ...(v.descriptionOk ? [] : ["description"]),
            ...(v.receiptOk ? [] : ["receipt"]),
          ];
          if (!still.length) {
            log.ok("verified complete (public API)");
            done.push(payment);
          } else {
            log.warn(`still incomplete: ${still.join(", ")}`);
            if (!escalations.some((e) => e.payment.kind === "payable" && e.payment.payableId === payment.payableId))
              escalations.push({ payment, reason: `still missing: ${still.join(", ")}` });
          }
        } else {
          // A payment with no oracle answer has no payable to fall back on — the public
          // API cannot see it yet. Say so instead of asserting success. (The JavaScript
          // version called verifyPayable(null) here, which 404s and kills the whole run.)
          log.warn("Spendesk's control rules did not answer for this payment");
          escalations.push({ payment, reason: "could not confirm with Spendesk that this is now complete" });
        }
      }
    }
  } finally {
    await closeQuietly(context);
  }

  log.say();
  log.say(`${done.length} completed, ${escalations.length} need${escalations.length === 1 ? "s" : ""} you`);
  log.record("run", {
    dry,
    via,
    incomplete: incomplete.length,
    done: done.length,
    escalations: escalations.length,
  });

  if (escalations.length) await sendDigest(escalations, { sessionOk, preview: dry, completed: done.length });

  return { done: done.length, escalations: escalations.length, incomplete: incomplete.length, via };
}
