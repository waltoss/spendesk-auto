// Starting the CLI from the listener — for the emailed link and for the dashboard buttons.
//
// One thing at a time. Every command that opens a browser opens the *same* Chrome profile
// (`.browser-data/`), and Chrome refuses a second process on a profile that is in use: the
// second run dies on launch with a lock error that says nothing useful. So a job that
// needs the browser is refused while anything else holds the profile — another job, the
// 08:00 launchd run, or a `bun run reauth` typed by hand. Chrome's own SingletonLock is the
// one signal all of those share.
//
// Each job leaves two files in logs/jobs/: its output, and a small JSON record. They are
// read back from disk rather than kept in memory, so the listing survives the listener
// being restarted by launchd.
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as log from "./log.ts";

const ROOT = path.resolve(import.meta.dir, "..");
const DIR = path.join(ROOT, "logs", "jobs");
const PROFILE_LOCK = path.join(ROOT, ".browser-data", "SingletonLock");
/** Enough history to answer "what happened this week"; older records are pruned. */
const KEEP = 60;

export const JOBS = {
  dry: { args: ["run", "--dry"], label: "Dry run", browser: true },
  run: { args: ["run"], label: "Run now", browser: true },
  go: { args: ["go"], label: "Sign in, then run", browser: true },
  reauth: { args: ["reauth"], label: "Sign in", browser: true },
  check: { args: ["check"], label: "Check sessions", browser: true },
  rules: { args: ["rules:check"], label: "Check rules", browser: false },
  "fetch-gcp": { args: ["fetch", "gcp"], label: "List GCP invoices", browser: true },
  "fetch-anthropic": { args: ["fetch", "anthropic"], label: "List Anthropic invoices", browser: true },
  "fetch-cursor": { args: ["fetch", "cursor"], label: "List Cursor invoices", browser: true },
} as const satisfies Record<string, { args: readonly string[]; label: string; browser: boolean }>;

export type JobKind = keyof typeof JOBS;

export const isJobKind = (s: string): s is JobKind => Object.hasOwn(JOBS, s);

export interface Job {
  id: string;
  kind: JobKind;
  label: string;
  via: "dashboard" | "email";
  pid: number | null;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Who holds the Chrome profile, if anyone. The lock is a symlink to "<host>-<pid>" and is
 * left behind when Chrome crashes, so a dead pid means free.
 */
export function profileHolder(lockPath = PROFILE_LOCK): number | null {
  try {
    const pid = Number(/-(\d+)$/.exec(readlinkSync(lockPath))?.[1]);
    return pid && alive(pid) ? pid : null;
  } catch {
    return null;
  }
}

const recordPath = (id: string): string => path.join(DIR, `${id}.json`);
export const logPath = (id: string): string => path.join(DIR, `${id}.log`);

function save(job: Job): void {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(recordPath(job.id), JSON.stringify(job));
}

/** A job whose listener restarted underneath it has no endedAt; its pid says the rest. */
export const isRunning = (job: Job): boolean => job.endedAt === null && job.pid !== null && alive(job.pid);

export function listJobs(): Job[] {
  try {
    return readdirSync(DIR)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .reverse()
      .flatMap((f) => {
        try {
          return [JSON.parse(readFileSync(path.join(DIR, f), "utf8")) as Job];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

export const getJob = (id: string): Job | null => listJobs().find((j) => j.id === id) ?? null;

/** When the job last wrote anything — a running job that has gone quiet is probably stuck. */
export function lastOutputAt(id: string): string | null {
  try {
    return statSync(logPath(id)).mtime.toISOString();
  } catch {
    return null;
  }
}

export function readJobLog(id: string): string {
  try {
    return readFileSync(logPath(id), "utf8");
  } catch {
    return "";
  }
}

function prune(): void {
  for (const job of listJobs().slice(KEEP)) {
    for (const file of [recordPath(job.id), logPath(job.id)]) Bun.file(file).unlink().catch(() => {});
  }
}

/** Why a job cannot start right now, or null if it can. */
export function blocker(kind: JobKind): string | null {
  const running = listJobs().find(isRunning);
  if (running) return `"${running.label}" is still running`;
  if (JOBS[kind].browser) {
    const pid = profileHolder();
    if (pid) return `the browser profile is in use (pid ${pid}) — the daily run or a sign-in is probably under way`;
  }
  return null;
}

export type StartResult = { ok: true; job: Job } | { ok: false; reason: string };

export function start(kind: JobKind, via: Job["via"]): StartResult {
  const reason = blocker(kind);
  if (reason) return { ok: false, reason };

  // Sortable, and safe in a URL and a file name.
  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${kind}`;
  mkdirSync(DIR, { recursive: true });
  const spec = JOBS[kind];
  // One append-mode descriptor for both streams: they interleave in order instead of
  // overwriting each other, and — unlike a pipe — the child keeps writing if the listener
  // is restarted mid-run. A pipe would hand it SIGPIPE and kill the run.
  const out = openSync(logPath(id), "a");
  const proc = Bun.spawn([process.execPath, "src/index.ts", ...spec.args], {
    cwd: ROOT,
    stdout: out,
    stderr: out,
    env: process.env,
  });
  closeSync(out);
  const job: Job = {
    id,
    kind,
    label: spec.label,
    via,
    pid: proc.pid,
    startedAt: new Date().toISOString(),
    endedAt: null,
    exitCode: null,
  };
  save(job);
  log.record("job", { id, kind, via });

  // Detached from the request: a run outlives it by minutes. The record is completed here
  // if the listener is still alive when the job ends; otherwise isRunning() reads the pid.
  proc.unref();
  void proc.exited.then((exitCode) => {
    save({ ...job, endedAt: new Date().toISOString(), exitCode });
    prune();
  });
  return { ok: true, job };
}
