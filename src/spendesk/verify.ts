// Never model completeness — ask Spendesk.
//
// Two €180 payables, both description-less and both with receipts, disagreed on
// completionState (DESIGN §8.5). Whatever rule produces that, we cannot see it, so after
// writing we re-read and let Spendesk answer.
import type { BrowserContext } from "playwright";
import { Completion } from "../schemas/spendesk.ts";
import { internalApiAs } from "./auth.ts";
import { getAttachmentCount, getPayable } from "./queue.ts";

export interface PayableVerification {
  fieldsOk: boolean;
  missingFields: string[];
  descriptionOk: boolean;
  receiptOk: boolean;
  version: number | null;
}

/** What we can check without a browser session: fields, description, receipt. */
export async function verifyPayable(
  payableId: string,
  { requiredFields = [] }: { requiredFields?: string[] } = {},
): Promise<PayableVerification> {
  const [payable, attachments] = await Promise.all([getPayable(payableId), getAttachmentCount(payableId)]);

  const present = payable.analyticalProperties.map((a) => (a.fieldName ?? "").trim());
  const missing = requiredFields.filter(
    (label) => !present.some((p) => p === label.trim() || p.startsWith(label.trim())),
  );

  return {
    fieldsOk: missing.length === 0,
    missingFields: missing,
    descriptionOk: Boolean((payable.description ?? "").trim()),
    receiptOk: attachments > 0,
    version: payable.version ?? null,
  };
}

/** The authority, when a session exists. */
export async function completionState(context: BrowserContext, paymentId: string): Promise<string | null> {
  const res = await internalApiAs(
    Completion,
    context,
    "GET",
    `/control-rules/completions/by-payment/${paymentId}`,
  );
  return res.state ?? null;
}
