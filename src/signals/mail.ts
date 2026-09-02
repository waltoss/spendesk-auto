// Spendesk's notification emails, read from Mail.app.
//
// Preferred over the Gmail API for one reason: nothing here can expire. The Gmail grant
// died once with `invalid_grant: invalid_rapt` — Google's ReAuth Proof Token, driven by a
// Workspace policy we do not control — and the whole point of reading email is to answer
// "does anything need me?" without an interactive login. A local mail client has no token
// to revoke.
//
// Costs: Mail.app must hold the account and have synced. We never launch it: a background
// job that opens a window on a sleeping desk is worse than falling back to Gmail.
import { classify, type Signal } from "./gmail.ts";
import * as log from "../log.ts";

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
//   per-account mailbox, filtered       ~16s
//   sender filter outside the `whose`   minutes  (one Apple Event per message)
// So: keep both predicates inside the `whose` clause, and walk accounts explicitly.
// Gmail also returns each message twice (Inbox and All Mail), hence the de-duplication.
const SCRIPT = (days: number) => `
tell application "Mail"
  set cutoff to (current date) - (${days} * days)
  set out to ""
  repeat with acct in accounts
    repeat with mbox in mailboxes of acct
      try
        repeat with m in (messages of mbox whose date received > cutoff and sender contains "spendesk")
          set out to out & ((date received of m) as «class isot» as string) & tab & (subject of m) & linefeed
        end repeat
      end try
    end repeat
  end repeat
  return out
end tell`;

export async function readSignals({ days = 7, timeoutMs = 45_000 }: { days?: number; timeoutMs?: number } = {}): Promise<Signal[] | null> {
  try {
    if (!(await mailIsRunning())) {
      log.step("Mail.app is not running — not launching it");
      return null;
    }
    // Bounded: Mail.app can take minutes on a large mailbox, and a daily run must not
    // hang on it. Exceeding the budget is not an error — it falls back to the Gmail API.
    const proc = Bun.spawn(["osascript", "-e", SCRIPT(days)], { stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    if (code !== 0) throw new Error(err.trim().slice(0, 200) || `osascript exited ${code} (budget ${timeoutMs}ms)`);

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
    // Most likely a missing Automation permission; say so rather than returning silence.
    log.warn(`Mail.app unavailable: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
