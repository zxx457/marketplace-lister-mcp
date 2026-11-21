/**
 * Offline create-form photo upload. The page is a local fixture, not Facebook.
 * It cannot reproduce a session Facebook has decided to block.
 *
 * Photo waits are shortened through FB_MCP_*_MS so a stuck count does not sit
 * for the live 15s/20s. Unset, those waits stay the live values.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lister-upload-test-"));
process.env.FB_MCP_PROFILE_DIR = path.join(root, "facebook");
process.env.FB_MCP_PHOTO_WAIT_MS = "800";
process.env.FB_MCP_UPLOAD_SETTLE_MS = "800";
process.env.FB_MCP_PHOTO_PAUSE_MIN_MS = "0";
process.env.FB_MCP_PHOTO_PAUSE_MAX_MS = "0";
fs.mkdirSync(process.env.FB_MCP_PROFILE_DIR, { recursive: true });

const listing = await import("../dist/listing.js");
const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, "fixtures", "create-form.html"), "utf8");
const photos = [path.join(root, "01.jpg"), path.join(root, "02.jpg")];
for (const file of photos) fs.writeFileSync(file, "fixture-photo");

let browser;

before(async () => {
  browser = await chromium.launch({ channel: "chrome", headless: true });
});

after(async () => {
  await browser?.close();
});

async function openForm(mode) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.route("https://www.facebook.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html })
  );
  await page.goto("https://www.facebook.com/marketplace/create/item");
  await page.evaluate((nextMode) => {
    window.__mode = nextMode;
    window.__ignoreEscape = nextMode === "overlay";
  }, mode);
  return {
    page,
    async close() {
      await context.close();
    },
  };
}

async function pageState(page) {
  return page.evaluate(() => ({
    count: document.getElementById("count").textContent,
    calls: window.__calls.slice(),
    published: window.__published === true,
    closeClicks: window.__closeClicks,
    oopsOpen: document.getElementById("oops").classList.contains("open"),
  }));
}

test("normal upload counts both photos and does not publish", async () => {
  const form = await openForm("ok");
  try {
    await listing.uploadPhotos(form.page, photos);
    const state = await pageState(form.page);
    assert.equal(state.count, "2");
    assert.deepEqual(state.calls, [1, 1]);
    assert.equal(state.published, false);
    assert.equal(state.oopsOpen, false);
  } finally {
    await form.close();
  }
});

test("Oops with zero photos is reported as a failure and the batch retry still does not succeed", async () => {
  const form = await openForm("oops");
  try {
    let caught;
    try {
      await listing.uploadPhotos(form.page, photos);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, "uploadPhotos resolved with zero photos");
    assert.equal(caught.name, "PhotoOopsError");
    assert.match(caught.message, /got 0 of 2/);
    assert.match(caught.message, /after Facebook showed: Oops/);
    assert.match(caught.message, /one upload/);
    assert.equal(listing.isRetryableListingFailure(caught), true);
    assert.equal(listing.uploadModeAfterFailure(false, caught), true);

    const state = await pageState(form.page);
    assert.equal(state.count, "0");
    assert.deepEqual(state.calls, [1, 2]);
    assert.equal(state.published, false);

    let reported;
    try {
      await listing.throwListingFailure(form.page, caught);
    } catch (err) {
      reported = err;
    }
    assert.match(reported.message, /got 0 of 2/);
    assert.match(reported.message, /Nothing was published/);
    assert.match(reported.message, /Debug screenshot: /);
    assert.doesNotMatch(reported.message, /Draft ready/);
    const shot = reported.message.split("Debug screenshot: ")[1].trim();
    assert.equal(fs.existsSync(shot), true);

    await form.page.reload();
    await form.page.evaluate(() => {
      window.__mode = "oops";
    });
    let retried;
    try {
      await listing.uploadPhotos(form.page, photos, true);
    } catch (err) {
      retried = err;
    }
    assert.ok(retried, "the batch retry resolved with zero photos");
    assert.equal(retried.name, "PhotoOopsError");
    assert.match(retried.message, /got 0 of 2/);
    assert.equal(listing.isRetryableListingFailure(retried), true);
    const after = await pageState(form.page);
    assert.equal(after.count, "0");
    assert.deepEqual(after.calls, [2]);
    assert.equal(after.published, false);
  } finally {
    await form.close();
  }
});

test("a covered Oops Close button is dismissed without a click-intercept timeout", async () => {
  const form = await openForm("overlay");
  try {
    await form.page.evaluate(() => window.__showOops());
    let intercepted;
    try {
      await form.page.locator('[aria-label="Close"]').click({ timeout: 1000 });
    } catch (err) {
      intercepted = err;
    }
    assert.ok(intercepted, "a normal click on the covered Close button was expected to fail");
    assert.match(intercepted.message, /intercept/i);
    assert.match(intercepted.message, /__fb-light-mode/);
    assert.equal((await pageState(form.page)).oopsOpen, true);

    let caught;
    try {
      await listing.uploadPhotos(form.page, photos);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, "uploadPhotos resolved with zero photos");
    assert.equal(caught.name, "PhotoOopsError");
    assert.match(caught.message, /got 0 of 2/);
    assert.match(caught.message, /Oops/);
    assert.doesNotMatch(caught.message, /intercept/i);
    assert.equal(listing.isRetryableListingFailure(caught), true);

    const state = await pageState(form.page);
    assert.equal(state.count, "0");
    assert.equal(state.published, false);
    assert.equal(state.oopsOpen, false);
    assert.ok(state.closeClicks >= 1, "Close never received a click");
  } finally {
    await form.close();
  }
});
