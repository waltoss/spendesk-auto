// Scheduling, two ways.
//
// What actually runs today is the launchd plist in `launchd/`, installed with
// `bun run schedule:launchd`. It is unchanged and remains the default: it is the thing
// that has been observed to work, it survives a reboot, and its stdout/stderr go where
// this project's logs already are.
//
// Bun 1.4 also ships `Bun.cron(path, schedule, title)`, which on macOS registers a real
// launchd job of its own (`launchctl list` shows it) and spawns a fresh `bun` process per
// fire. That is a genuine alternative rather than an in-process timer, so it is offered
// here — but it writes its stdout to /tmp/bun.cron.<title>.{stdout,stderr}.log rather than
// to `logs/`, which is why it is not the default.
//
// Daily, not monthly. A payable appears on day 2 and the card is blocked on day 3, so the
// actionable window is about 24 hours (DESIGN §1). 08:00 puts the digest in the inbox
// before the working day, leaving a full day to answer it.
import path from "node:path";
import * as log from "./log.ts";

export const CRON = "0 8 * * *";
export const TITLE = "spendesk-daily";

const JOB = path.join(import.meta.dir, "job.ts");

/** Register the daily job with Bun's scheduler (macOS: launchd, under its own label). */
export async function schedule(): Promise<void> {
  await Bun.cron(JOB, CRON, TITLE);
  log.ok(`scheduled "${TITLE}" — ${CRON} (${JOB})`);
  await describeSchedule();
  log.step("logs: /tmp/bun.cron.spendesk-daily.stdout.log");
  log.step(`inspect: launchctl list | grep ${TITLE}`);
}

export async function unschedule(): Promise<void> {
  await Bun.cron.remove(TITLE);
  log.ok(`removed "${TITLE}"`);
}

/** Pure: parses the expression and prints the next fire time. Registers nothing. */
export async function describeSchedule(): Promise<void> {
  const next = Bun.cron.parse(CRON);
  log.step(next ? `next run: ${next.toLocaleString("fr-FR")}` : `"${CRON}" never fires — check the expression`);
}
