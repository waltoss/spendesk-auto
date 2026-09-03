// One digest a day, and only when something genuinely needs a decision.
//
// Measured on 131 days of history: 16 days had anything to ask, so ~3.7 emails a month,
// never more than one a day, most days none (DESIGN §2). Every item says what it is, what
// is missing, how long is left before the card blocks, and the one action to take.
import { $ } from "bun";
import type { Escalation } from "./types.ts";
import * as log from "./log.ts";

const TO = Bun.env.EMAIL_TO || "thomas.walter@theodo.com";
const APP = "https://app.spendesk.com";

/** "1) Cette dépense concerne-t-elle votre budget confort ?" -> "budget confort ?" */
const shortLabel = (label: string | undefined): string => (label ?? "").split(")").pop()?.trim() ?? "";

const hours = (h: number | null | undefined): string => {
  if (h === null || h === undefined) return "unknown time";
  const n = Math.round(h);
  return n >= 0 ? `${n}h left` : `overdue by ${-n}h`;
};

export interface DigestOptions {
  /** null when the browser was never opened — a dry run has not proved the session dead. */
  sessionOk?: boolean | null;
  completed?: number;
  /** One-click link that signs in and finishes the run. Null when no session is needed. */
  actionUrl?: string | null;
  /**
   * Things that need saying but are not queue items — above all, a charge whose payable
   * Spendesk has not minted yet. Without a session that charge is invisible to the queue,
   * so it would otherwise produce no email at all, on the very days it matters most.
   */
  notes?: string[];
}

export function digestText(
  escalations: Escalation[],
  { sessionOk = true, completed = 0, actionUrl = null, notes = [] }: DigestOptions = {},
): string {
  const soonest = Math.min(...escalations.map((e) => e.payment.hoursRemaining ?? Infinity));
  const lines: string[] = [];

  if (escalations.length)
    lines.push(
      escalations.length === 1
        ? "One expense needs you before your card is blocked."
        : `${escalations.length} expenses need you before your card is blocked.`,
    );
  for (const note of notes) lines.push(note);
  if (Number.isFinite(soonest)) lines.push(`The most urgent: ${hours(soonest)}.`);
  lines.push("");

  for (const { payment, reason, ask } of escalations) {
    // For an "ask", the question already covers the fields — listing them as well is noise.
    // What still matters is anything the reply cannot supply, like a missing receipt.
    const missing = payment.needs
      .filter((n) => !(ask && n.kind === "field"))
      .map((n) => (n.kind === "field" ? shortLabel(n.label) : n.kind));
    lines.push(
      `• ${payment.supplier ?? "(no supplier)"} — ${payment.amount.toFixed(2)} ${payment.currency} on ${payment.paidAt}`,
    );
    lines.push(`  ${hours(payment.hoursRemaining)}${missing.length ? ` · missing: ${missing.join(", ")}` : ""}`);
    lines.push(`  ${ask ? `Reply to this email: ${reason}` : reason}`);
    lines.push("");
  }

  // Deep-linking to a single payable would be better, but the app's URL for a public-API
  // payable id has never been verified — a dead link in an urgent email is worse than a
  // list. Revisit once there is a session to check it against.
  lines.push(`${APP}/payments/all`);
  lines.push("");

  if (sessionOk === false) {
    lines.push("Spendesk needs you to sign in again — descriptions cannot be written without it.");
    if (actionUrl) {
      // The whole point of the link: no command to type, and no window opens until this
      // is clicked. One use only, and superseded by the next digest.
      lines.push("");
      lines.push("Finish these automatically — click here, then Touch ID:");
      lines.push(`  ${actionUrl}`);
      lines.push("");
      lines.push("A Chrome window opens for the sign-in, everything is completed, and you");
      lines.push("get a second email with whatever still needs you.");
    } else {
      lines.push("Run: bun run reauth   (Touch ID, then approve on the Spendesk phone app)");
    }
    lines.push("");
  }

  if (completed) lines.push(`${completed} other expense${completed > 1 ? "s were" : " was"} completed automatically.`);
  return lines.join("\n");
}

export interface SendOptions extends DigestOptions {
  /** A dry run prints the email rather than sending it. */
  preview?: boolean;
}

export async function sendDigest(
  escalations: Escalation[],
  { sessionOk = true, preview = false, completed = 0, actionUrl = null, notes = [] }: SendOptions = {},
): Promise<void> {
  const first = escalations[0];
  if (!first && !notes.length) return;

  const subject = !first
    ? "Spendesk: a recent charge is not visible yet"
    : escalations.length === 1
      ? `Spendesk: 1 expense needs you (${hours(first.payment.hoursRemaining)})`
      : `Spendesk: ${escalations.length} expenses need you`;
  const body = digestText(escalations, { sessionOk, completed, actionUrl, notes });

  // A dry run shows the email it would send rather than a summary of it: the wording is
  // the part worth reviewing.
  if (preview || Bun.env.DIGEST_STDOUT) {
    log.head(`[digest → ${TO}] ${subject}`);
    log.say(body);
    return;
  }

  // Mail.app via AppleScript: no SMTP credentials to store, and it sends from the
  // account the user already has open. The escaping below is AppleScript's, not the
  // shell's — Bun.$ handles the shell layer, so the script goes across as one argument.
  const esc = (s: string): string => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const script = `
    tell application "Mail"
      set newMessage to make new outgoing message with properties ¬
        {subject:"${esc(subject)}", content:"${esc(body)}", visible:false}
      tell newMessage
        make new to recipient at end of to recipients with properties {address:"${TO}"}
      end tell
      send newMessage
    end tell`;

  try {
    await $`osascript -e ${script}`.quiet();
    log.ok(`digest sent to ${TO}`);
    log.record("digest", { to: TO, items: escalations.length, notes: notes.length });
  } catch (e) {
    // A failed email must not look like a successful run.
    const message = e instanceof Error ? e.message : String(e);
    log.fail(`could not send the digest: ${message}`);
    log.head(subject);
    log.say(body);
    log.record("digest-failed", { to: TO, items: escalations.length, message });
  }
}
