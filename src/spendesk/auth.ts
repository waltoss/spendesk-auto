// Two APIs, two credentials.
//
//   public API    documented, client-credentials.       Reads the queue, writes fields
//                 Scopes are company-wide (DESIGN §9).   and attachments.
//   internal API  the app's own, session-cookie auth.   Writes the description and answers
//                 Undocumented.                          the completeness oracle.
//
// The public API is enough for everything except the description, which is why a dead
// session degrades the run rather than stopping it.
import { Buffer } from "node:buffer";
import path from "node:path";
import type { BrowserContext } from "playwright";
import type { z } from "zod";
import { parsed, TokenResponse } from "../schemas/spendesk.ts";

export const PUBLIC_API = "https://public-api.spendesk.com";
export const INTERNAL_API = "https://api.spendesk.com";
export const APP = "https://app.spendesk.com";
export const GRAPHQL = `${INTERNAL_API}/graphql`;

// Stable per company. Override for another Theodo entity rather than editing this file.
export const COMPANY_ID = Bun.env.SPENDESK_COMPANY_ID || "2avcxkezrxmosd";

const CREDS_FILE = path.resolve(process.cwd(), ".spendesk-api");

let token: string | null = null;
let tokenExpiresAt = 0;

async function credentials(): Promise<{ id: string; secret: string }> {
  const file = Bun.file(CREDS_FILE);
  if (!(await file.exists()))
    throw new Error(`missing ${path.basename(CREDS_FILE)} — it must hold "ID=..." and "Secret=..."`);
  const raw = await file.text();
  const id = /^ID=(.*)$/im.exec(raw)?.[1]?.trim();
  const secret = /^Secret=(.*)$/im.exec(raw)?.[1]?.trim();
  if (!id || !secret) throw new Error(`${path.basename(CREDS_FILE)} must contain an ID= and a Secret= line`);
  return { id, secret };
}

/** A stalled connection must fail, not hang: a run left waiting forever never sends its digest. */
const TIMEOUT_MS = 30_000;
const RETRY_DELAYS_MS = [2_000, 5_000, 15_000];

/**
 * fetch with a timeout, and — for requests that are safe to repeat — retries.
 *
 * Both failures seen in the run log are transient: "getaddrinfo ENOTFOUND" at 08:00, when
 * the Mac has just woken and the network is not up yet (five runs lost in a week), and a
 * connection that stalls without ever answering (a sign-in-then-run left waiting forever).
 * Only reads are retried. A write that timed out may still have landed, and sending it
 * again is how an attachment ends up on a payable twice.
 */
async function send(url: string, init: RequestInit, { retry }: { retry: boolean }): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (retry && res.status >= 500 && attempt < RETRY_DELAYS_MS.length) {
        await res.body?.cancel();
        await Bun.sleep(RETRY_DELAYS_MS[attempt]!);
        continue;
      }
      return res;
    } catch (e) {
      if (!retry || attempt >= RETRY_DELAYS_MS.length) {
        const what = e instanceof Error && e.name === "TimeoutError" ? `no answer after ${TIMEOUT_MS / 1000}s` : e;
        throw new Error(`${init.method ?? "GET"} ${new URL(url).pathname} failed: ${what instanceof Error ? what.message : String(what)}`);
      }
      await Bun.sleep(RETRY_DELAYS_MS[attempt]!);
    }
  }
}

async function accessToken(): Promise<string> {
  if (token && Date.now() < tokenExpiresAt) return token;
  const { id, secret } = await credentials();
  const basic = Buffer.from(`${id}:${secret}`).toString("base64");
  // A token request changes nothing server-side, so it is as safe to repeat as a read.
  const res = await send(
    `${PUBLIC_API}/v1/auth/token`,
    { method: "POST", headers: { authorization: `Basic ${basic}` } },
    { retry: true },
  );
  if (!res.ok) throw new Error(`Spendesk token request failed: HTTP ${res.status} ${await res.text()}`);
  const body = parsed(TokenResponse, await res.json(), "POST /v1/auth/token");
  token = body.access_token;
  // expires_in is seconds (3600); renew a minute early.
  tokenExpiresAt = Date.now() + ((body.expires_in ?? 3600) - 60) * 1000;
  return token;
}

export interface PublicApiOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
}

/**
 * Call the public API and hand back the raw JSON.
 *
 * Untyped on purpose: the caller pairs it with the zod schema for that endpoint, so the
 * assertion lives next to the code that knows what it wanted. Throws with the server's
 * own message, which is usually precise.
 */
export async function publicApi(pathname: string, { method = "GET", body }: PublicApiOptions = {}): Promise<unknown> {
  // A search is a POST only because its filters are a body; it reads.
  const idempotent = method === "GET" || (method === "POST" && pathname.endsWith("/search"));
  const res = await send(
    `${PUBLIC_API}${pathname}`,
    {
      method,
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
    { retry: idempotent },
  );
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${pathname} → HTTP ${res.status}: ${text.slice(0, 400)}`);
  return text ? (JSON.parse(text) as unknown) : null;
}

/** Typed wrapper: fetch and validate in one step. */
export async function publicApiAs<T>(
  schema: z.ZodType<T>,
  pathname: string,
  options: PublicApiOptions = {},
): Promise<T> {
  return parsed(schema, await publicApi(pathname, options), `${options.method ?? "GET"} ${pathname}`);
}

/** Page through a public-API collection. Theodo has >30 users, so this is not optional. */
export async function publicApiAll<T>(
  schema: z.ZodType<T>,
  pathname: string,
  { pageSize = 30, maxPages = 40 }: { pageSize?: number; maxPages?: number } = {},
): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const sep = pathname.includes("?") ? "&" : "?";
    const raw = await publicApi(`${pathname}${sep}page=${page}&pageSize=${pageSize}`);
    // Some collections answer { data: [...] }, others a bare array.
    const list =
      raw && typeof raw === "object" && "data" in raw ? (raw as { data: unknown }).data : raw;
    const items = Array.isArray(list) ? list : [];
    for (const item of items) out.push(parsed(schema, item, `GET ${pathname}`));
    if (items.length < pageSize) break;
  }
  return out;
}

// ------------------------------------------------------------------ internal API

/** One request that answers "does the session cookie still work?". */
async function ping(context: BrowserContext): Promise<boolean> {
  try {
    const res = await context.request.get(`${INTERNAL_API}/api/${COMPANY_ID}/custom-fields`, {
      headers: { origin: APP, referer: `${APP}/` },
      timeout: 10_000,
    });
    return res.ok();
  } catch {
    return false;
  }
}

/**
 * SPX_ACCESS_TOKEN is short-lived inside a year-long cookie; the SPA exchanges
 * SPX_REFRESH_TOKEN for a new one. A bare request never triggers that exchange, so a 401
 * is not a verdict — load the app once and ask again. (This is the check the first
 * session-check prototype was missing, and it is why cookie expiry != session lifetime.)
 */
export async function sessionAlive(
  context: BrowserContext,
  { allowRefresh = true }: { allowRefresh?: boolean } = {},
): Promise<boolean> {
  if (await ping(context)) return true;
  if (!allowRefresh) return false;

  const page = await context.newPage();
  try {
    await page.goto(`${APP}/app`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(4000);
  } catch {
    // the retry below is the real verdict
  } finally {
    await page.close().catch(() => {});
  }
  return ping(context);
}

/** Call the internal app API with the browser's session cookie. */
export async function internalApi(
  context: BrowserContext,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  pathname: string,
  body?: unknown,
): Promise<unknown> {
  const url = `${INTERNAL_API}/api/${COMPANY_ID}${pathname}`;
  const res = await context.request.fetch(url, {
    method,
    headers: { origin: APP, referer: `${APP}/`, "content-type": "application/json" },
    ...(body ? { data: body } : {}),
    timeout: 20_000,
  });
  const text = await res.text();
  if (!res.ok()) throw new Error(`${method} ${pathname} → HTTP ${res.status()}: ${text.slice(0, 300)}`);
  return text ? (JSON.parse(text) as unknown) : null;
}

/** Typed wrapper for the internal API. */
export async function internalApiAs<T>(
  schema: z.ZodType<T>,
  context: BrowserContext,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  pathname: string,
  body?: unknown,
): Promise<T> {
  return parsed(schema, await internalApi(context, method, pathname, body), `${method} ${pathname}`);
}
