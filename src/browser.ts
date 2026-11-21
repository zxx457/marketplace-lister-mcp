import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

/**
 * Two ways to reach Facebook.
 *
 * Default: a dedicated Chrome profile. Login state lives in its own
 * user-data-dir, not in the user's day-to-day Chrome. The user logs in once
 * (fb_login) and the session persists here across restarts.
 *
 * Opt-in: FB_MCP_CDP_URL, for example http://127.0.0.1:9230. The lister
 * attaches to a Chrome the user already started with remote debugging. That
 * is the same browser they post from by hand, so Facebook sees one session.
 * The lister opens its own tab in that window and, on shutdown, closes only
 * that tab. It does not close the browser or any other tab.
 */

// One profile per marketplace, so adding another platform later doesn't share
// or clobber this one's session. Falls back to the pre-rename location so an
// existing login keeps working without signing in again.
const LEGACY_DIR = path.join(os.homedir(), ".fb-marketplace-mcp", "profile");
const DEFAULT_DIR = path.join(os.homedir(), ".marketplace-lister-mcp", "facebook");

const PROFILE_DIR =
  process.env.FB_MCP_PROFILE_DIR ||
  (fs.existsSync(DEFAULT_DIR) || !fs.existsSync(LEGACY_DIR) ? DEFAULT_DIR : LEGACY_DIR);

// Optional: use an installed Chrome/Edge channel instead of bundled Chromium.
// Bundled Chromium is the default so `npx` works with zero extra setup.
const CHANNEL = process.env.FB_MCP_CHANNEL; // e.g. "chrome" | "msedge"

type Held =
  | { kind: "launch"; context: BrowserContext }
  | { kind: "cdp"; browser: Browser; context: BrowserContext; page: Page | null };

let held: Held | null = null;

/** http(s) or ws(s) DevTools address. Empty when the lister should launch its own Chrome. */
export function cdpEndpoint(): string {
  const raw = (process.env.FB_MCP_CDP_URL || "").trim();
  if (!raw) return "";
  if (/^(https?|wss?):\/\//i.test(raw)) return raw.replace(/\/+$/, "");
  if (/^\d+$/.test(raw)) return `http://127.0.0.1:${raw}`;
  return `http://${raw.replace(/\/+$/, "")}`;
}

export function usingExistingBrowser(): boolean {
  return cdpEndpoint() !== "";
}

/** What fb_login_status prints after logged_in. */
export function sessionDescription(): string {
  const endpoint = cdpEndpoint();
  if (endpoint) return `browser: existing Chrome at ${endpoint}`;
  return `profile_dir: ${PROFILE_DIR}`;
}

/**
 * Chrome shows "Restore pages? Chrome didn't shut down correctly" when the
 * previous process was killed. That bubble sits on top of the create form.
 * exit_type "Crashed" and exited_cleanly false are what trigger it; a clean
 * exit is written before launch. --hide-crash-restore-bubble covers a profile
 * Chrome rewrites as crashed while it is starting.
 */
export function suppressCrashedSession(userDataDir: string): void {
  const files = [path.join(userDataDir, "Default", "Preferences"), path.join(userDataDir, "Preferences")];
  for (const preferencesPath of files) {
    if (!fs.existsSync(preferencesPath)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(preferencesPath, "utf8"));
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const root = parsed as Record<string, unknown>;
    const current = root.profile;
    const profile: Record<string, unknown> =
      current && typeof current === "object" && !Array.isArray(current) ? { ...(current as Record<string, unknown>) } : {};
    if (profile.exit_type === "Normal" && profile.exited_cleanly === true) continue;
    profile.exit_type = "Normal";
    profile.exited_cleanly = true;
    root.profile = profile;
    const tmp = `${preferencesPath}.${process.pid}.tmp`;
    try {
      const mode = fs.statSync(preferencesPath).mode;
      fs.writeFileSync(tmp, JSON.stringify(root), { mode });
      fs.renameSync(tmp, preferencesPath);
    } catch {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* the original Preferences file is left as it was */
      }
    }
  }
}

async function launch(channel?: string): Promise<BrowserContext> {
  return chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    channel,
    viewport: null,
    args: ["--disable-blink-features=AutomationControlled", "--hide-crash-restore-bubble"],
  });
}

/** A cached context is useless once its browser is gone: closed by the user,
 *  crashed, or killed. Detect that and relaunch rather than handing back a
 *  dead handle, which otherwise breaks every later call until a restart. */
async function isAlive(c: BrowserContext, allowNewPage: boolean): Promise<boolean> {
  try {
    const open = c.pages().filter((p) => !p.isClosed());
    const p = open[0] ?? (allowNewPage ? await c.newPage() : null);
    if (!p) return false;
    await p.evaluate(() => 1);
    return true;
  } catch {
    return false;
  }
}

async function releaseCdp(session: Extract<Held, { kind: "cdp" }>, closeOurPage: boolean): Promise<void> {
  if (closeOurPage && session.page && !session.page.isClosed()) {
    await session.page.close().catch(() => {});
  }
  session.page = null;
  // browser.close() on a CDP connection drops the DevTools socket. It does not
  // send Browser.close, so the user's Chrome keeps running.
  if (session.browser.isConnected()) await session.browser.close().catch(() => {});
}

async function attach(): Promise<Extract<Held, { kind: "cdp" }>> {
  const endpoint = cdpEndpoint();
  if (held?.kind === "cdp") {
    if (held.browser.isConnected() && (await isAlive(held.context, false))) return held;
    await releaseCdp(held, false);
    held = null;
  }
  if (held?.kind === "launch") {
    await held.context.close().catch(() => {});
    held = null;
  }
  let browser: Browser;
  try {
    browser = await chromium.connectOverCDP(endpoint);
  } catch (err) {
    throw new Error(
      `Could not attach to the Chrome at ${endpoint}. ` +
        `Leave that Chrome open with remote debugging (for example --remote-debugging-port=9230 --remote-debugging-address=127.0.0.1) ` +
        `and set FB_MCP_CDP_URL to its http address. The lister will not start a second browser.\n` +
        `Last error: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  const context = browser.contexts()[0];
  if (!context) {
    await browser.close().catch(() => {});
    throw new Error(
      `Chrome at ${endpoint} has no open window to attach to. Open that Chrome and try again. A second browser was not started.`
    );
  }
  held = { kind: "cdp", browser, context, page: null };
  return held;
}

async function launchContext(): Promise<BrowserContext> {
  if (held?.kind === "cdp") {
    await releaseCdp(held, true);
    held = null;
  }
  if (held?.kind === "launch") {
    if (await isAlive(held.context, true)) return held.context;
    await held.context.close().catch(() => {});
    held = null;
  }
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  // A killed Chrome leaves exit_type "Crashed". Clear that before the new
  // process starts, or the restore-session bubble covers the create form.
  suppressCrashedSession(PROFILE_DIR);
  // Prefer an installed browser: nearly everyone has one, and it keeps install
  // fast by not requiring Playwright's ~150 MB Chromium download. Bundled
  // Chromium is the last resort, and some Windows setups can't spawn it at all
  // ("spawn UNKNOWN"), which is why this walks a list instead of picking one.
  const order = CHANNEL ? [CHANNEL] : ["chrome", "msedge", undefined];
  let lastErr: unknown;
  for (const ch of order) {
    try {
      const context = await launch(ch);
      held = { kind: "launch", context };
      return context;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(
    `Could not launch a browser (tried: ${order.map((c) => c ?? "bundled Chromium").join(", ")}).\n` +
      `Install Google Chrome, or run: npx playwright install chromium\n` +
      `To pin one, set FB_MCP_CHANNEL=chrome (or msedge).\n` +
      `To drive the Chrome you already use for Facebook instead, set FB_MCP_CDP_URL=http://127.0.0.1:9230.\n` +
      `Last error: ${String(lastErr)}`
  );
}

export async function getContext(): Promise<BrowserContext> {
  if (usingExistingBrowser()) return (await attach()).context;
  return launchContext();
}

export async function getPage(): Promise<Page> {
  if (usingExistingBrowser()) {
    const session = await attach();
    if (!session.page || session.page.isClosed()) session.page = await session.context.newPage();
    await session.page.bringToFront().catch(() => {});
    return session.page;
  }
  const c = await getContext();
  const pages = c.pages().filter((p) => !p.isClosed());
  return pages.length ? pages[0] : await c.newPage();
}

/** True if a Facebook session cookie (c_user) is present. */
export async function isLoggedIn(): Promise<boolean> {
  const c = await getContext();
  const cookies = await c.cookies("https://www.facebook.com");
  return cookies.some((ck) => ck.name === "c_user" && !!ck.value);
}

export async function closeContext(): Promise<void> {
  if (!held) return;
  if (held.kind === "cdp") await releaseCdp(held, true);
  else await held.context.close().catch(() => {});
  held = null;
}

export function profileDir(): string {
  return PROFILE_DIR;
}
