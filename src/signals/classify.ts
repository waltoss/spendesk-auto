// Turning a Spendesk notification subject line into a typed event.
//
// Pure and dependency-free on purpose: this is the part worth testing, and it should not
// drag a mail client or an API client into the test.
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

/** Is Spendesk telling us the card is about to be blocked? Its word beats our arithmetic. */
export function blockWarning(signals: Signal[]): Signal | null {
  const cutoff = Date.now() - 36 * 36e5; // the warning gives 24h; allow slack for a late run
  return signals.find((s) => s.kind === "block-warning" && s.at.getTime() > cutoff) ?? null;
}
