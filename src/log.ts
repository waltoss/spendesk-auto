// Console output for a human, plus a JSONL record of every run.
//
// The JSONL matters: DESIGN §11 records that the Spendesk session died after 14 idle
// days but cannot say whether it died of idleness. Only a month of dated run records
// answers that, so every session death is logged with the elapsed time since the last
// known-good run.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

const LOG_DIR = path.resolve(process.cwd(), "logs");
const RUNS = path.join(LOG_DIR, "runs.jsonl");

export const runId = new Date().toISOString();

const c = process.stdout.isTTY
  ? { dim: "\x1b[2m", red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", bold: "\x1b[1m", off: "\x1b[0m" }
  : { dim: "", red: "", green: "", yellow: "", bold: "", off: "" };

export const say = (m = ""): void => console.log(m);
export const dim = (m: string): void => console.log(`${c.dim}${m}${c.off}`);
export const head = (m: string): void => console.log(`\n${c.bold}${m}${c.off}`);
export const ok = (m: string): void => console.log(`  ${c.green}✓${c.off} ${m}`);
export const warn = (m: string): void => console.log(`  ${c.yellow}!${c.off} ${m}`);
export const fail = (m: string): void => console.log(`  ${c.red}✗${c.off} ${m}`);
export const step = (m: string): void => console.log(`  ${c.dim}·${c.off} ${m}`);

export interface RunEvent {
  at: string;
  runId: string;
  event: string;
  [key: string]: unknown;
}

/**
 * Append one structured event. Never throws: logging must not break a run.
 *
 * Deliberately synchronous `node:fs` rather than `Bun.write`, which replaces a file
 * rather than appending to it — this is an append-only ledger and losing yesterday's
 * session-death record would defeat the point of keeping it.
 */
export function record(event: string, data: Record<string, unknown> = {}): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(RUNS, `${JSON.stringify({ at: new Date().toISOString(), runId, event, ...data })}\n`);
  } catch {
    /* ignore */
  }
}

/** The most recent event of a kind, so we can report "session lasted N days". */
export function lastEvent(event: string): RunEvent | null {
  try {
    const lines = readFileSync(RUNS, "utf8").trim().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line) continue;
      const parsed: unknown = JSON.parse(line);
      if (parsed && typeof parsed === "object" && (parsed as RunEvent).event === event) return parsed as RunEvent;
    }
  } catch {
    /* ignore */
  }
  return null;
}
