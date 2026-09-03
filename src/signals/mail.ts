// Spendesk's notification emails, read from Mail.app.
//
// Appealing for one reason: nothing here can expire. The Gmail grant died once with
// `invalid_grant: invalid_rapt` — Google's ReAuth Proof Token, driven by a Workspace policy
// we do not control — and the whole point of reading email is to answer "does anything need
// me?" without an interactive login. A local mail client has no token to revoke.
//
// Costs: Mail.app must hold the account and have synced. We never launch it: a background
// job that opens a window on a sleeping desk is worse than falling back to Gmail.
import { classify, type Signal } from "./classify.ts";
import * as log from "../log.ts";

/** The Gmail label, which IMAP presents to Mail.app as a mailbox of the same name. */
export const MAILBOX = process.env["SPENDESK_MAIL_MAILBOX"] ?? "Spendesk";

/** Is Mail.app already running? `tell application "Mail"` would launch it otherwise. */
export async function mailIsRunning(): Promise<boolean> {
  const proc = Bun.spawn(["osascript", "-e",
    'tell application "System Events" to return (exists (processes where name is "Mail"))'], {
    stdout: "pipe", stderr: "pipe",
  });
  const out = (await new Response(proc.stdout).text()).trim();
  return (await proc.exited) === 0 && out === "true";
}

// Mailbox choice is the whole performance story here, and it is not intuitive:
//   unified `inbox`                     > 100s   (aggregates across accounts)
//   every mailbox, sender in the `whose`   ~16s and often silently empty
//   one named mailbox, date only          ~0.8s
// The named mailbox wins because the sender predicate — the expensive part — has already
// been evaluated server-side by the Gmail filter that applies the label. So the rule is not
// a convenience: it is what makes this source viable.
//
// NOMAILBOX matters as much as the speed. A missing mailbox must be an error, not an empty
// list: "no messages" reads as "nothing needs you", which is the one wrong answer here.
const SENTINEL = "!!NOMAILBOX";
const SCRIPT = (days: number) => `
tell application "Mail"
  set cutoff to (current date) - (${days} * days)
  set out to ""
  set found to false
  repeat with acct in accounts
    try
      set mbox to mailbox "${MAILBOX}" of acct
      set found to true
      repeat with m in (messages of mbox whose date received > cutoff)
        set out to out & ((date received of m) as «class isot» as string) & tab & (subject of m) & linefeed
      end repeat
    end try
  end repeat
  if found is false then return "${SENTINEL}"
  return out
end tell`;

export async function readSignals({ days = 7, timeoutMs = 20_000 }: { days?: number; timeoutMs?: number } = {}): Promise<Signal[] | null> {
  try {
    if (!(await mailIsRunning())) {
      log.step("Mail.app is not running — not launching it");
      return null;
    }
    // Bounded: a daily run must not hang on Mail.app. Exceeding the budget is not an
    // error — it falls back to the Gmail API.
    const proc = Bun.spawn(["osascript", "-e", SCRIPT(days)], { stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    if (code !== 0) throw new Error(err.trim().slice(0, 200) || `osascript exited ${code} (budget ${timeoutMs}ms)`);
    if (out.includes(SENTINEL)) {
      throw new Error(`no mailbox named "${MAILBOX}" — create the Gmail filter that applies the label`);
    }

    // Gmail can present a message under both its label and All Mail; de-duplicate.
    const seen = new Set<string>();
    const signals: Signal[] = [];
    for (const line of out.split("\n")) {
      const [iso, ...rest] = line.split("\t");
      if (!iso || !rest.length) continue;
      const subject = rest.join("\t").trim();
      const key = `${iso}|${subject}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const at = new Date(iso);
      if (Number.isNaN(at.getTime())) continue;
      const signal = classify(subject, at);
      if (signal) signals.push(signal);
    }
    return signals.sort((a, b) => b.at.getTime() - a.at.getTime());
  } catch (e) {
    // Most likely a missing Automation permission or a missing label; say so rather than
    // returning silence.
    log.warn(`Mail.app unavailable: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
