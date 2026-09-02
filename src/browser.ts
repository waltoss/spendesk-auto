// The one place that knows how to launch a browser carrying the user's real sessions.
//
// Playwright, not Bun.WebView. Bun 1.4 does ship `Bun.WebView`, and it is a real headless
// browser, but it is the wrong tool twice over: it cannot show a window at all
// ("headless: false is not yet implemented"), and its persistent `dataStore` is not the
// Chrome profile in `.browser-data/` that actually holds the Spendesk, Google and Cursor
// logins. See src/reauth.ts for the one place where it was genuinely worth testing.
//
// Both launch options below are load-bearing (DESIGN §11):
//   channel: "chrome"      macOS will not hand a passkey request to Playwright's bundled
//                          "Chrome for Testing" — it degrades to a "scan this QR code"
//                          dialog. Real Chrome gets the system credential provider and
//                          Touch ID appears.
//   chromiumSandbox: true  otherwise Playwright passes --no-sandbox and Chrome paints a
//                          security warning on a window the user did not open.
import path from "node:path";
import { chromium, type BrowserContext } from "playwright";

export const PROFILE = path.resolve(process.cwd(), ".browser-data");

export interface OpenOptions {
  headless?: boolean;
  viewport?: { width: number; height: number };
}

export async function openContext({
  headless = true,
  viewport = { width: 1500, height: 950 },
}: OpenOptions = {}): Promise<BrowserContext> {
  return chromium.launchPersistentContext(PROFILE, {
    channel: "chrome",
    chromiumSandbox: true,
    headless,
    acceptDownloads: true,
    viewport,
    // Drop --enable-automation: it paints "Chrome is being controlled by automated test
    // software". Keep extensions enabled so 1Password can answer.
    ignoreDefaultArgs: ["--disable-extensions", "--enable-automation"],
  });
}

/** Run fn with a context, always closing it. */
export async function withBrowser<T>(opts: OpenOptions, fn: (context: BrowserContext) => Promise<T>): Promise<T> {
  const context = await openContext(opts);
  try {
    return await fn(context);
  } finally {
    await context.close().catch(() => {});
  }
}

/** Closing a browser is never worth failing a run over. */
export async function closeQuietly(context: BrowserContext | null | undefined): Promise<void> {
  await context?.close().catch(() => {});
}
