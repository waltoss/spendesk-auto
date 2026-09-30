// The dashboard can start runs that write to Spendesk, from a listener any website can
// send requests to. So the tests that matter most are the refusals.
import { expect, test } from "bun:test";
import { mkdtempSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { hostAllowed, sameOrigin } from "../src/dashboard/index.ts";
import { esc } from "../src/dashboard/page.ts";
import { isInvoiceName, runRows, spendeskSignIn, vendorSignIn } from "../src/dashboard/state.ts";
import { profileHolder } from "../src/jobs.ts";
import type { RunEvent } from "../src/log.ts";

const PORT = 8787;
const req = (headers: Record<string, string>, method = "POST"): Request =>
  new Request(`http://127.0.0.1:${PORT}/jobs`, { method, headers });

test("only this listener's own host name is served — DNS rebinding arrives under another", () => {
  expect(hostAllowed(req({ host: "127.0.0.1:8787" }, "GET"), PORT)).toBe(true);
  expect(hostAllowed(req({ host: "localhost:8787" }, "GET"), PORT)).toBe(true);
  expect(hostAllowed(req({ host: "attacker.example:8787" }, "GET"), PORT)).toBe(false);
  expect(hostAllowed(req({ host: "127.0.0.1:9999" }, "GET"), PORT)).toBe(false);
});

test("a button press must come from the dashboard itself", () => {
  expect(sameOrigin(req({ origin: "http://127.0.0.1:8787", "sec-fetch-site": "same-origin" }), PORT)).toBe(true);
  expect(sameOrigin(req({ origin: "https://attacker.example" }), PORT)).toBe(false);
  expect(sameOrigin(req({ origin: "http://127.0.0.1:8787", "sec-fetch-site": "cross-site" }), PORT)).toBe(false);
  // What Chrome sends under Referrer-Policy: no-referrer — refused, which is why the
  // page uses same-origin instead.
  expect(sameOrigin(req({ origin: "null" }), PORT)).toBe(false);
  // Neither header: not a browser we can vouch for.
  expect(sameOrigin(req({}), PORT)).toBe(false);
});

test("third-party text is escaped", () => {
  expect(esc(`<img src=x onerror="alert(1)">`)).toBe("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
});

test("invoice links cannot leave the invoices folder", () => {
  expect(isInvoiceName("GCFRD0014403556.pdf")).toBe(true);
  expect(isInvoiceName("../.spendesk-api")).toBe(false);
  expect(isInvoiceName("../../etc/passwd.pdf")).toBe(false);
  expect(isInvoiceName(".hidden.pdf")).toBe(false);
});

const ev = (at: string, event: string, extra: Record<string, unknown> = {}, runId = at): RunEvent => ({
  at,
  runId,
  event,
  ...extra,
});

test("a Spendesk session confirmed long ago is not reported as signed in", () => {
  const now = new Date("2026-09-30T12:00:00Z").getTime();
  expect(spendeskSignIn([ev("2026-09-30T11:30:00Z", "session-alive")], now).state).toBe("alive");
  expect(spendeskSignIn([ev("2026-09-30T08:00:00Z", "session-alive")], now).state).toBe("stale");
  expect(
    spendeskSignIn([ev("2026-09-30T11:30:00Z", "session-alive"), ev("2026-09-30T11:40:00Z", "session-dead")], now)
      .state,
  ).toBe("dead");
  expect(spendeskSignIn([], now).state).toBe("unknown");
});

test("a failed invoice fetch marks that vendor signed out until it works again", () => {
  const events = [
    ev("2026-09-01T08:00:00Z", "vendors-checked"),
    ev("2026-09-10T08:00:00Z", "vendor-signed-out", { vendor: "gcp" }),
  ];
  expect(vendorSignIn(events, "Google", "gcp").state).toBe("dead");
  expect(vendorSignIn(events, "Cursor", "cursor").state).toBe("alive");
  events.push(ev("2026-09-11T08:00:00Z", "vendor-status", { vendor: "Google", alive: true }));
  expect(vendorSignIn(events, "Google", "gcp").state).toBe("alive");
});

test("runs are grouped by process, and the listener's clicks are not a run", () => {
  const listener = "2026-09-01T00:00:00.000Z";
  const rows = runRows([
    ev("2026-09-29T06:00:00Z", "trigger", {}, listener),
    ev("2026-09-30T06:00:01Z", "session-dead", {}, "2026-09-30T06:00:00.000Z"),
    ev("2026-09-30T06:01:00Z", "run", { dry: false, incomplete: 2, done: 1, escalations: 1, via: "payables" }, "2026-09-30T06:00:00.000Z"),
    ev("2026-09-30T07:21:00Z", "crash", { command: "go", message: "browser closed" }, "2026-09-30T07:19:00.000Z"),
  ]);
  expect(rows.map((r) => [r.kind, r.status])).toEqual([
    ["sign-in", "crash"],
    ["run", "attention"],
  ]);
});

test("a stale Chrome profile lock (dead pid) does not block jobs", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "lock-"));
  const stale = path.join(dir, "stale");
  symlinkSync("host-999999", stale); // no such pid
  expect(profileHolder(stale)).toBeNull();
  const live = path.join(dir, "live");
  symlinkSync(`host-${process.pid}`, live);
  expect(profileHolder(live)).toBe(process.pid);
  expect(profileHolder(path.join(dir, "absent"))).toBeNull();
});
