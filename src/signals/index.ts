// Where the Spendesk notification emails come from.
//
// Mail.app, and only Mail.app. There was a Gmail API reader here, through the `gws` CLI,
// and it was removed: that credential is shared with unrelated tooling, so re-issuing it
// for another purpose silently narrowed the scopes this needed, and the binary moved
// install location, which broke resolution outright and — because the reader was
// fail-soft — reported "no signals" rather than an error. A source that other work can
// invalidate, silently, is the wrong foundation for "does anything need me?".
//
// Mail.app can do the job only because a Gmail-side filter labels the mail server-side,
// which leaves one small, deterministically-named mailbox to read. Without it this source
// scanned every mailbox, took 100s+, and returned an empty list when handed a bad mailbox
// reference — and empty reads as "nothing needs you", the one wrong answer here.
//
// With no second source there is nothing to cross-check against, so the distinction that
// matters is encoded in the type: `signals: null` means "could not look", which is not the
// same as "nothing is waiting" and must never be reported as calm.
import * as mail from "./mail.ts";
import type { Signal } from "./classify.ts";

export type { Signal } from "./classify.ts";
export { blockWarning, classify, parseAmount } from "./classify.ts";

export async function readSignals(
  opts: { days?: number } = {},
): Promise<{ signals: Signal[] | null; source: string }> {
  return { signals: await mail.readSignals(opts), source: "Mail.app" };
}
