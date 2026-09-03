// The emailed link is the one place this project asks the user to click something, so the
// two properties worth pinning are: it appears only when signing in would actually help,
// and it never appears when it would not.
import { test, expect } from "bun:test";
import { digestText } from "../src/notify.ts";
import { actionUrl } from "../src/trigger.ts";
import type { Escalation, QueueItem } from "../src/types.ts";

const item = (over: Partial<QueueItem> = {}): QueueItem =>
  ({
    kind: "payable", payableId: "p1", supplier: null, description: "", amount: 120,
    currency: "USD", paidAt: "2026-09-03", cardId: null, hoursRemaining: 34,
    hasReceipt: false, fields: {}, needs: [{ kind: "description" }],
    completionState: "incomplete", searchState: null, version: 1, ...over,
  }) as QueueItem;

const esc = (reason: string): Escalation => ({ payment: item(), reason });

test("the link is shown when a session is what is missing", () => {
  const body = digestText([esc("description needs a Spendesk session — please re-authenticate")], {
    sessionOk: false,
    actionUrl: actionUrl("TOKEN123"),
  });
  expect(body).toContain("TOKEN123");
  expect(body).toContain("127.0.0.1");
  // The typed command is the fallback for when there is no link; showing both is noise.
  expect(body).not.toContain("bun run reauth");
});

test("without a link, the digest still says how to sign in", () => {
  const body = digestText([esc("description needs a Spendesk session")], { sessionOk: false });
  expect(body).toContain("bun run reauth");
  expect(body).not.toContain("127.0.0.1");
});

test("a live session never offers a sign-in link", () => {
  const body = digestText([esc("the receipt is missing and cannot be fetched automatically")], {
    sessionOk: true,
    actionUrl: actionUrl("TOKEN123"),
  });
  expect(body).not.toContain("TOKEN123");
  expect(body).not.toContain("sign in");
});

test("the action url is loopback-only", () => {
  // Binding anywhere else would put expense completion on the network.
  expect(new URL(actionUrl("x")).hostname).toBe("127.0.0.1");
});
