// Where the Spendesk notification emails come from.
//
// Gmail via gws is primary: it is fast (seconds), correct, and its failures are loud —
// a 401 with a named reason. Mail.app is the more appealing idea, because nothing local
// can have its token revoked, but in practice it is fiddly: query cost swings from 0.1s to
// minutes depending on which mailbox reference is used, and a wrong reference returns an
// empty list rather than an error. An empty list reads as "nothing needs you", which is
// the one failure this project cannot tolerate.
//
// So Mail.app stays as a fallback for when the Gmail grant dies (see REDESIGN.md §4 on
// invalid_rapt), and is used only when it actually returns something.
import * as mail from "./mail.ts";
import * as gmail from "./gmail.ts";
import type { Signal } from "./gmail.ts";
import * as log from "../log.ts";

export type { Signal } from "./gmail.ts";
export { blockWarning, classify, parseAmount } from "./gmail.ts";

export async function readSignals(opts: { days?: number } = {}): Promise<{ signals: Signal[]; source: string }> {
  const fromGmail = await gmail.readSignals(opts);
  if (fromGmail.length) return { signals: fromGmail, source: "gmail" };

  // Gmail returned nothing: either a genuinely quiet week or a dead grant. Ask Mail.app
  // rather than assume the quiet week — being wrong here means missing a blocked card.
  const fromMail = await mail.readSignals(opts);
  if (fromMail && fromMail.length) {
    log.warn("Gmail returned nothing but Mail.app did — check the Gmail grant");
    return { signals: fromMail, source: "Mail.app" };
  }
  return { signals: fromGmail, source: "gmail" };
}
