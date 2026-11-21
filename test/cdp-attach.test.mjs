/**
 * Attaching to a Chrome that is already running, instead of launching one.
 * The browser here is a local headless Chrome with a debugging port, not Facebook.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lister-cdp-"));
process.env.FB_MCP_PROFILE_DIR = path.join(root, "unused-lister-profile");
delete process.env.FB_MCP_CDP_URL;

const browserMod = await import("../dist/browser.js");
const login = await import("../dist/login.js");

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitForJson(port) {
  const url = `http://127.0.0.1:${port}/json/version`;
  const deadline = Date.now() + 15000;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      last = `HTTP ${response.status}`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Chrome debugging port ${port} did not open (${last})`);
}

async function targets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok) throw new Error(`json/list HTTP ${response.status}`);
  const list = await response.json();
  return list.filter((item) => item.type === "page");
}

let chrome;

after(async () => {
  delete process.env.FB_MCP_CDP_URL;
  await browserMod.closeContext().catch(() => {});
  if (chrome && !chrome.killed) chrome.kill("SIGKILL");
});

test("without FB_MCP_CDP_URL the lister is not in attach mode", () => {
  delete process.env.FB_MCP_CDP_URL;
  assert.equal(browserMod.cdpEndpoint(), "");
  assert.equal(browserMod.usingExistingBrowser(), false);
  assert.match(browserMod.sessionDescription(), /^profile_dir: /);
});

test("a bad debugging address fails before a second browser is started", async () => {
  process.env.FB_MCP_CDP_URL = "http://127.0.0.1:1";
  try {
    await assert.rejects(browserMod.getContext(), /Could not attach to the Chrome at http:\/\/127\.0\.0\.1:1/);
    await assert.rejects(browserMod.getPage(), /second browser/);
  } finally {
    delete process.env.FB_MCP_CDP_URL;
    await browserMod.closeContext().catch(() => {});
  }
});

test("CDP mode opens one tab in the existing Chrome and leaves the rest running", async () => {
  const port = await freePort();
  const profile = path.join(root, "user-chrome");
  fs.mkdirSync(profile, { recursive: true });
  chrome = spawn(
    "/usr/bin/google-chrome",
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: "ignore" }
  );
  await waitForJson(port);
  const before = await targets(port);
  assert.ok(before.length >= 1, "the user's Chrome should already have a tab");
  const userIds = new Set(before.map((item) => item.id));

  process.env.FB_MCP_CDP_URL = `http://127.0.0.1:${port}`;
  assert.equal(browserMod.usingExistingBrowser(), true);
  assert.equal(browserMod.cdpEndpoint(), `http://127.0.0.1:${port}`);

  const loggedOut = await browserMod.isLoggedIn();
  assert.equal(loggedOut, false);
  const afterStatus = await targets(port);
  assert.equal(afterStatus.length, before.length, "checking login opened a tab");

  const pending = await login.smoothLogin(1000);
  assert.equal(pending.status, "pending");
  assert.match(pending.message, /will not start its own browser/);
  assert.match(pending.message, /second Facebook session/);
  assert.doesNotMatch(pending.message, /dedicated profile/);
  const afterLogin = await targets(port);
  assert.equal(afterLogin.length, before.length, "fb_login opened a tab or a browser");

  const page = await browserMod.getPage();
  await page.goto("data:text/html,<title>lister-tab</title><p>lister</p>");
  const again = await browserMod.getPage();
  assert.equal(await again.title(), "lister-tab");
  const withLister = await targets(port);
  assert.equal(withLister.length, before.length + 1);
  for (const id of userIds) {
    assert.ok(withLister.some((item) => item.id === id), `user tab ${id} disappeared`);
  }

  const context = await browserMod.getContext();
  await context.addCookies([
    {
      name: "c_user",
      value: "100",
      domain: ".facebook.com",
      path: "/",
      expires: Math.floor(Date.now() / 1000) + 3600,
      httpOnly: true,
      secure: true,
      sameSite: "None",
    },
  ]);
  assert.equal(await browserMod.isLoggedIn(), true);
  const signedIn = await login.smoothLogin(1000);
  assert.equal(signedIn.status, "already_logged_in");
  assert.match(signedIn.message, /attached Chrome/);
  assert.match(signedIn.message, /does not open a second Facebook session/);
  assert.equal(browserMod.sessionDescription(), `browser: existing Chrome at http://127.0.0.1:${port}`);

  await browserMod.closeContext();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(chrome.exitCode, null, "closeContext quit the user's Chrome");
  assert.equal(chrome.signalCode, null);
  const version = await fetch(`http://127.0.0.1:${port}/json/version`);
  assert.equal(version.ok, true);
  const afterClose = await targets(port);
  assert.equal(afterClose.some((item) => item.title === "lister-tab"), false);
  for (const id of userIds) {
    assert.ok(afterClose.some((item) => item.id === id), `user tab ${id} was closed on shutdown`);
  }
});
