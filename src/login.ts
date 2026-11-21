import { cdpEndpoint, getContext, getPage, isLoggedIn, usingExistingBrowser } from "./browser.js";

export interface LoginResult {
  status: "already_logged_in" | "logged_in" | "pending";
  account?: string;
  message: string;
}

async function readAccountName(): Promise<string | undefined> {
  try {
    const page = await getPage();
    const name = await page.evaluate(() => {
      const el = document.querySelector('[aria-label="Your profile"]') as HTMLElement | null;
      if (el?.textContent) return el.textContent.trim();
      const link = document.querySelector('a[href*="/me/"], a[aria-current="page"]') as HTMLElement | null;
      return link?.textContent?.trim() || undefined;
    });
    return name || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Smooth, idempotent login that fits inside MCP request timeouts.
 *
 * - If already signed in: returns instantly.
 * - Otherwise: opens Facebook's real login page in the dedicated window, brings
 *   it forward, and waits a short bounded window (default 45s, under the common
 *   60s client timeout) for the user to finish. If they finish in time it
 *   returns "logged_in"; if not it returns "pending" and the caller simply
 *   calls fb_login AGAIN to keep waiting. The user types their password only on
 *   Facebook's own page, only once — the session then persists in the profile.
 */
export async function smoothLogin(waitMs = 45000): Promise<LoginResult> {
  if (usingExistingBrowser()) {
    // The Facebook session is the one already in the user's Chrome. Opening a
    // login page here would be that same session, but a missing cookie should
    // be fixed by the user in their own window, not by a second browser.
    await getContext();
    const endpoint = cdpEndpoint();
    if (await isLoggedIn()) {
      return {
        status: "already_logged_in",
        account: await readAccountName(),
        message: `Already signed in in the attached Chrome (${endpoint}). The lister uses that window and does not open a second Facebook session.`,
      };
    }
    return {
      status: "pending",
      message:
        `The lister is attached to the Chrome at ${endpoint} and will not start its own browser or a second Facebook session. ` +
        `Sign in to Facebook in that window, then call fb_login again.`,
    };
  }

  await getContext(); // launches the window
  const page = await getPage();

  if (await isLoggedIn()) {
    return { status: "already_logged_in", account: await readAccountName(), message: "Already logged in — nothing to do." };
  }

  // Only navigate to the login page if we're not already sitting on it, so
  // re-calling fb_login doesn't interrupt a login in progress.
  if (!/facebook\.com\/(login|checkpoint|two_factor)/.test(page.url())) {
    await page.goto("https://www.facebook.com/login", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  }
  await page.bringToFront().catch(() => {});

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(2000);
    if (await isLoggedIn()) {
      await page.goto("https://www.facebook.com/", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
      return { status: "logged_in", account: await readAccountName(), message: "Login successful. Session saved to the dedicated profile — you won't need to do this again." };
    }
  }
  return {
    status: "pending",
    message: "A Facebook login window is open. Finish signing in there (including any 2FA), then call fb_login again to confirm — it will detect the session and continue.",
  };
}
