/**
 * Publish is one click, and a second process can see that a listing is already claimed.
 * The page is a local fixture, not Facebook. The journal is a temp file.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { chromium } from "playwright";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lister-publish-once-"));
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.FB_MCP_PROFILE_DIR = path.join(root, "facebook");
delete process.env.FB_MCP_CDP_URL;
fs.mkdirSync(process.env.FB_MCP_PROFILE_DIR, { recursive: true });
fs.mkdirSync(path.join(root, "journals"), { recursive: true });

const listing = await import("../dist/listing.js");
const guard = await import("../dist/publish-guard.js");
const browserMod = await import("../dist/browser.js");

const guardModule = pathToFileURL(path.join(repo, "dist/publish-guard.js")).href;

function journal(name) {
  return path.join(root, "journals", name);
}

function readEntries(file) {
  return JSON.parse(fs.readFileSync(file, "utf8")).entries;
}

function restoreEnv(name, previous) {
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
}

function claimInChild(file, title, price) {
  const script = `
    const { claimPublish } = await import(${JSON.stringify(guardModule)});
    try {
      const claim = claimPublish(process.env.JOURNAL_PATH, process.env.CLAIM_TITLE, process.env.CLAIM_PRICE);
      process.stdout.write(JSON.stringify({ ok: true, id: claim.id, status: claim.status }));
    } catch (err) {
      process.stdout.write(JSON.stringify({
        ok: false,
        name: err instanceof Error ? err.name : "Error",
        message: err instanceof Error ? err.message : String(err),
      }));
    }
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, JOURNAL_PATH: file, CLAIM_TITLE: title, CLAIM_PRICE: String(price) },
  });
  assert.equal(
    result.status,
    0,
    `child exited ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
  );
  return JSON.parse(result.stdout);
}

function createHtml(leave) {
  return `<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>lister-create</title></head>
  <body>
    <div role="button" id="publish">Publish</div>
    <script>
      document.getElementById("publish").addEventListener("click", () => {
        const n = Number(sessionStorage.getItem("publishClicks") || "0") + 1;
        sessionStorage.setItem("publishClicks", String(n));
        if (${leave ? "true" : "false"}) {
          setTimeout(() => {
            location.href = "https://www.facebook.com/marketplace/you/selling";
          }, 50);
        }
      });
    </script>
  </body>
</html>`;
}

const sellingHtml = `<!doctype html><html><head><title>lister-selling</title></head><body><p>Selling</p></body></html>`;

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

let browser;
let chrome;

before(async () => {
  browser = await chromium.launch({ channel: "chrome", headless: true });
});

after(async () => {
  delete process.env.FB_MCP_CDP_URL;
  await browserMod.closeContext().catch(() => {});
  await browser?.close().catch(() => {});
  if (chrome && !chrome.killed) chrome.kill("SIGKILL");
});

async function openCreatePage(leave) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const html = createHtml(leave);
  await page.route("https://www.facebook.com/**", (route) => {
    const url = route.request().url();
    const body = url.includes("/marketplace/create") ? html : sellingHtml;
    return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body });
  });
  await page.goto("https://www.facebook.com/marketplace/create/item");
  return {
    page,
    clicks() {
      return page.evaluate(() => Number(sessionStorage.getItem("publishClicks") || "0"));
    },
    close() {
      return context.close();
    },
  };
}

describe("publish once", { concurrency: false }, () => {
  test("the journal file sits beside the profile directory", () => {
    const file = guard.publishJournalPath(browserMod.profileDir());
    assert.equal(path.basename(file), "publish-journal.json");
    assert.equal(path.dirname(file), path.dirname(browserMod.profileDir()));
    assert.notEqual(path.dirname(file), browserMod.profileDir());
  });

  test("journal refuses a duplicate normalized title and price", () => {
    const file = journal("duplicate.json");
    const claim = guard.claimPublish(file, "Wingspan Board Game", "$50");
    guard.settlePublish(file, claim, "published", "https://www.facebook.com/marketplace/item/1");
    assert.equal(fs.existsSync(`${file}.lock`), false);
    let caught;
    try {
      guard.claimPublish(file, "  wingspan   board game ", "50.00");
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof guard.DuplicateListingError);
    assert.equal(caught.name, "DuplicateListingError");
    assert.equal(caught.blockingStatus, "published");
    assert.match(caught.message, /already published/);
    assert.equal(readEntries(file).length, 1);
  });

  test("an unconfirmed claim blocks and a failed claim does not", () => {
    const blocked = journal("unconfirmed.json");
    const pending = guard.claimPublish(blocked, "Desk lamp", 40);
    guard.settlePublish(blocked, pending, "unconfirmed");
    let caught;
    try {
      guard.claimPublish(blocked, "Desk lamp", "$40.00");
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof guard.DuplicateListingError);
    assert.equal(caught.blockingStatus, "unconfirmed");

    const released = journal("failed.json");
    const failed = guard.claimPublish(released, "Desk lamp", 40);
    guard.settlePublish(released, failed, "failed");
    const again = guard.claimPublish(released, "desk lamp", "40");
    assert.equal(again.status, "in_progress");
    assert.equal(again.priceKey, "40.00");
  });

  test("an in-progress claim always blocks", () => {
    const file = journal("progress.json");
    guard.claimPublish(file, "Mixer", 200);
    let caught;
    try {
      guard.claimPublish(file, "Mixer", 200);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof guard.DuplicateListingError);
    assert.equal(caught.blockingStatus, "in_progress");
    assert.match(caught.message, /already in progress/);
  });

  test("another process sees the claim", () => {
    const file = journal("shared.json");
    const claim = guard.claimPublish(file, "KitchenAid Mixer", 200);
    const seen = claimInChild(file, "kitchenaid mixer", "$200.00");
    assert.equal(seen.ok, false);
    assert.equal(seen.name, "DuplicateListingError");
    assert.match(seen.message, /already in progress/);
    assert.equal(readEntries(file).some((entry) => entry.id === claim.id && entry.status === "in_progress"), true);
  });

  test("expired entries do not block", async () => {
    const previous = process.env.FB_MCP_DUPLICATE_WINDOW_MS;
    process.env.FB_MCP_DUPLICATE_WINDOW_MS = "80";
    try {
      const file = journal("expired.json");
      const published = guard.claimPublish(file, "Old boots", 90);
      guard.settlePublish(file, published, "published", "https://example.test/boots");
      guard.claimPublish(file, "Stale mixer", 20);
      await new Promise((resolve) => setTimeout(resolve, 250));
      const boots = guard.claimPublish(file, "Old boots", "90.00");
      const mixer = guard.claimPublish(file, "stale mixer", "$20");
      assert.equal(boots.status, "in_progress");
      assert.equal(mixer.status, "in_progress");
      assert.notEqual(boots.id, published.id);
    } finally {
      restoreEnv("FB_MCP_DUPLICATE_WINDOW_MS", previous);
    }
  });

  test("a different price is allowed", () => {
    const file = journal("price.json");
    const first = guard.claimPublish(file, "Wingspan", 50);
    guard.settlePublish(file, first, "published");
    const second = guard.claimPublish(file, "Wingspan", 60);
    assert.equal(second.status, "in_progress");
    assert.equal(second.priceKey, "60.00");
    assert.equal(first.priceKey, "50.00");
  });

  test("allow_duplicate overrides a published claim and an in-progress claim", () => {
    const file = journal("allow.json");
    const published = guard.claimPublish(file, "Chair", 25);
    guard.settlePublish(file, published, "published");
    const again = guard.claimPublish(file, "Chair", "25.00", true);
    assert.equal(again.status, "in_progress");
    const third = guard.claimPublish(file, "Chair", 25, true);
    assert.equal(third.status, "in_progress");
    assert.equal(readEntries(file).length, 3);
    let caught;
    try {
      guard.claimPublish(file, "Chair", 25);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof guard.DuplicateListingError);
  });

  test("Publish is clicked once when the page leaves the create flow", async () => {
    const previous = process.env.FB_MCP_PUBLISH_CONFIRM_MS;
    process.env.FB_MCP_PUBLISH_CONFIRM_MS = "4000";
    const form = await openCreatePage(true);
    try {
      const result = await listing.publishPreparedDraft(form.page);
      assert.equal(result.status, "published");
      assert.equal(result.url.includes("/marketplace/create"), false);
      assert.equal(await form.clicks(), 1);
    } finally {
      restoreEnv("FB_MCP_PUBLISH_CONFIRM_MS", previous);
      await form.close();
    }
  });

  test("Publish is clicked once and not again when confirmation times out", async () => {
    const previous = process.env.FB_MCP_PUBLISH_CONFIRM_MS;
    process.env.FB_MCP_PUBLISH_CONFIRM_MS = "300";
    const form = await openCreatePage(false);
    try {
      const result = await listing.publishPreparedDraft(form.page);
      assert.equal(result.status, "unconfirmed");
      assert.equal(result.message, "unconfirmed — check list_my_listings, do not retry");
      assert.equal(result.url.includes("/marketplace/create"), true);
      assert.equal(await form.clicks(), 1);
    } finally {
      restoreEnv("FB_MCP_PUBLISH_CONFIRM_MS", previous);
      await form.close();
    }
  });

  test("an aborted signal does not click Publish", async () => {
    const form = await openCreatePage(true);
    try {
      const signal = AbortSignal.abort();
      let caught;
      try {
        await listing.publishPreparedDraft(form.page, signal);
      } catch (err) {
        caught = err;
      }
      assert.ok(caught instanceof listing.PublishCancelledError);
      assert.match(caught.message, /Nothing was published/);
      assert.match(caught.message, /toolTimeoutSec/);
      assert.match(caught.message, /600/);
      assert.equal(await form.clicks(), 0);
      assert.equal(form.page.url().includes("/marketplace/create"), true);
    } finally {
      await form.close();
    }
  });

  test("post_listing claims before filling and a failed fill does not block", async () => {
    const file = journal("fill-failed.json");
    await assert.rejects(
      () =>
        listing.postListing(
          {
            title: "Desk lamp",
            price: 40,
            description: "Works",
            category: "Household",
            condition: "Used - Good",
            photos: [path.join(root, "missing.jpg")],
          },
          { journalPath: file }
        ),
      /Photo not found/
    );
    const saved = readEntries(file);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].status, "failed");
    assert.equal(saved[0].titleKey, "desk lamp");
    assert.equal(saved[0].priceKey, "40.00");
    const again = guard.claimPublish(file, "Desk lamp", "$40");
    assert.equal(again.status, "in_progress");
  });

  test("an aborted post_listing publishes nothing and releases the claim", async () => {
    const file = guard.publishJournalPath(browserMod.profileDir());
    fs.rmSync(file, { force: true });
    const result = await listing.postListing(
      {
        title: "Cancelled lamp",
        price: "$40",
        description: "n/a",
        category: "Household",
        condition: "Used - Good",
        photos: [path.join(root, "missing-cancelled.jpg")],
      },
      { signal: AbortSignal.abort() }
    );
    assert.equal(result.outcome, "cancelled");
    assert.equal(result.message, listing.CANCELLED_BEFORE_PUBLISH_MESSAGE);
    assert.match(result.message, /Nothing was published/);
    assert.match(result.message, /toolTimeoutSec/);
    assert.match(result.message, /600/);
    const saved = readEntries(file);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].status, "failed");
    const again = guard.claimPublish(file, "Cancelled lamp", 40);
    assert.equal(again.status, "in_progress");
  });

  test("the tool description and README tell the client to wait and not retry", () => {
    const source = fs.readFileSync(path.join(repo, "src/index.ts"), "utf8");
    const readme = fs.readFileSync(path.join(repo, "README.md"), "utf8");
    for (const text of [source, readme]) {
      assert.match(text, /1-4 minutes/);
      assert.match(text, /toolTimeoutSec/);
      assert.match(text, /600/);
      assert.match(text, /[Nn]ever retry a timed-out call/);
    }
    assert.match(source, /allow_duplicate/);
    assert.match(source, /extra\.signal/);
  });

  test("a confirmed publish in CDP mode closes only the lister tab", async () => {
    const previousConfirm = process.env.FB_MCP_PUBLISH_CONFIRM_MS;
    process.env.FB_MCP_PUBLISH_CONFIRM_MS = "8000";
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
    try {
      await waitForJson(port);
      const before = await targets(port);
      assert.ok(before.length >= 1);
      const userIds = new Set(before.map((item) => item.id));
      process.env.FB_MCP_CDP_URL = `http://127.0.0.1:${port}`;

      const page = await browserMod.getPage();
      const html = createHtml(true);
      await page.route("https://www.facebook.com/**", (route) => {
        const url = route.request().url();
        const body = url.includes("/marketplace/create") ? html : sellingHtml;
        return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body });
      });
      await page.goto("https://www.facebook.com/marketplace/create/item", { timeout: 15000 });

      const result = await listing.publishListing();
      assert.equal(result.status, "published");
      assert.equal(result.url.includes("/marketplace/create"), false);

      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(chrome.exitCode, null, "closing the lister tab quit the user's Chrome");
      assert.equal(chrome.signalCode, null);
      const version = await fetch(`http://127.0.0.1:${port}/json/version`);
      assert.equal(version.ok, true);
      const afterClose = await targets(port);
      assert.equal(
        afterClose.some((item) => item.title === "lister-create" || item.title === "lister-selling"),
        false
      );
      for (const id of userIds) {
        assert.ok(afterClose.some((item) => item.id === id), `user tab ${id} was closed`);
      }
    } finally {
      restoreEnv("FB_MCP_PUBLISH_CONFIRM_MS", previousConfirm);
      delete process.env.FB_MCP_CDP_URL;
      await browserMod.closeContext().catch(() => {});
      if (chrome && !chrome.killed) chrome.kill("SIGKILL");
      chrome = undefined;
    }
  });
});
