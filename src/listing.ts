import fs from "node:fs";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { getPage } from "./browser.js";

const CREATE_URL = "https://www.facebook.com/marketplace/create/item";
const SELLING_URL = "https://www.facebook.com/marketplace/you/selling";

const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);

export interface ScannedItem {
  folder: string;
  name: string;
  photos: string[];
}

export interface LoosePhoto {
  path: string;
  name: string;
  /** File modification time, ISO 8601. Photos of one item usually cluster. */
  modified: string;
  /**
   * Seconds between this photo and the previous one, null for the first.
   * Can be negative when files are not in chronological order, which is itself
   * a boundary signal: an older photo appearing mid-run came from another batch.
   */
  secondsAfterPrevious: number | null;
}

export type ScanResult =
  | { mode: "grouped"; folder: string; items: ScannedItem[] }
  | { mode: "ungrouped"; folder: string; photos: LoosePhoto[]; hint: string };

const UNGROUPED_HINT =
  "These photos are not sorted into items yet. Read them in the order given: " +
  "photos of the same item are almost always consecutive, since that is the " +
  "order they were taken in. Decide where one item ends and the next begins, " +
  "confirm the grouping with the seller, then call create_listing once per " +
  "item passing that item's photo paths in `photos`. A large jump in " +
  "secondsAfterPrevious, in either direction, marks a break between batches " +
  "and often a new item. Timestamps are only a hint though: copying a folder " +
  "resets them all to the same second. The images decide.";

function collect(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((f) => IMAGE_EXT.has(path.extname(f).toLowerCase()))
    .sort()
    .map((f) => path.join(dir, f));
}

/**
 * Scan a folder of things to sell.
 *
 * Subfolders present: each one is an item, already grouped by the seller.
 * Only loose images: they are returned individually so the model can look at
 * them and work out which photos belong to which item. Returning them as one
 * item would silently merge a whole moving sale into a single listing.
 */
export function scanItems(root: string): ScanResult {
  if (!fs.existsSync(root)) throw new Error(`Folder not found: ${root}`);
  const entries = fs.readdirSync(root, { withFileTypes: true });
  const subdirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith("_") && !e.name.startsWith("."));

  if (subdirs.length > 0) {
    return {
      mode: "grouped",
      folder: root,
      items: subdirs.map((d) => {
        const dir = path.join(root, d.name);
        return { folder: dir, name: d.name, photos: collect(dir) };
      }),
    };
  }

  const files = collect(root);
  if (files.length === 0) throw new Error(`No images or item subfolders in ${root}`);

  let prev: number | null = null;
  const photos: LoosePhoto[] = files.map((p) => {
    const ms = fs.statSync(p).mtimeMs;
    const gap = prev === null ? null : Math.round((ms - prev) / 1000);
    prev = ms;
    return {
      path: p,
      name: path.basename(p),
      modified: new Date(ms).toISOString(),
      secondsAfterPrevious: gap,
    };
  });

  return { mode: "ungrouped", folder: root, photos, hint: UNGROUPED_HINT };
}

export interface ListingInput {
  title: string;
  price: string | number;
  description: string;
  category: string; // e.g. "Appliances", "Household"
  condition: string; // "New" | "Used - Like New" | "Used - Good" | "Used - Fair"
  photos: string[]; // absolute paths
  /** Typed into the Location combobox. Omitted leaves Facebook's value. */
  location?: string;
  /** Sets the Hide from friends switch. Omitted leaves the switch alone. */
  hideFromFriends?: boolean;
  /** Each tag is typed and confirmed with Enter. Omitted leaves tags alone. */
  productTags?: string[];
  /**
   * Group names to tick on the "List in more places" step. Omitted leaves the
   * group checkboxes alone. An empty array unticks every group.
   */
  shareToGroups?: string[];
}

/** What fillListing verified, plus the review screenshot. */
export interface ListingDraft {
  screenshot: Buffer;
  location?: string;
  hideFromFriends?: boolean;
  tagsAdded: string[];
  tagsNotAdded: string[];
  groupsTicked: string[];
  groupsNotFound: string[];
  locationRequested: boolean;
  hideRequested: boolean;
  tagsRequested: boolean;
  groupsRequested: boolean;
}

/** Every image in a folder, sorted. Lets callers pass a folder instead of paths. */
export function photosInFolder(folder: string): string[] {
  if (!fs.existsSync(folder)) throw new Error(`Folder not found: ${folder}`);
  const files = fs
    .readdirSync(folder)
    .filter((f) => IMAGE_EXT.has(path.extname(f).toLowerCase()))
    .sort()
    .map((f) => path.join(folder, f));
  if (files.length === 0) throw new Error(`No images in ${folder}`);
  return files;
}

/**
 * Open the create form, waiting for the form itself rather than the URL.
 *
 * Facebook bounces this route back to the Marketplace feed fairly often, and
 * does so persistently once you have opened it many times in quick succession.
 * Back off between tries, and if it never lands, say that plainly instead of
 * failing later on a missing field.
 */
async function gotoCreate(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await page.goto(CREATE_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    } catch {
      /* keep trying */
    }
    await page.waitForTimeout(3000 + attempt * 2000);
    if (page.url().includes("/marketplace/create/item") && (await page.locator("label[role=combobox]").count()) > 0) {
      return;
    }
  }
  throw new Error(
    "Facebook kept redirecting away from the create-listing form (now at " +
      page.url() +
      "). This usually means too many listing attempts in a short window. " +
      "Wait 20-30 minutes and try again; the login itself is still fine."
  );
}

/**
 * Choose an option from one of the form's comboboxes.
 *
 * The option list is virtualised: entries that need scrolling are not in the
 * DOM at all, so clicking by exact text silently misses anything below the
 * fold. Scroll until it appears, match case-insensitively, and when it really
 * is not there, report the options that are, so the caller can pick a real one
 * instead of guessing.
 */
async function pickFromCombobox(page: Page, comboLabel: string, optionText: string): Promise<void> {
  await page.click(`label[role=combobox]:has-text("${comboLabel}")`, { timeout: 15000 });
  await page.waitForTimeout(1200);

  const seen = new Set<string>();
  for (let i = 0; i < 30; i++) {
    // Options are plain spans in the document, with no listbox wrapper to scope
    // to, so collect every short visible leaf span and match on text.
    const options: string[] = await page.evaluate(() =>
      [...document.querySelectorAll("span")]
        .filter((s) => s.offsetParent && !s.children.length)
        .map((s) => (s.textContent || "").trim())
        .filter((t) => t.length > 0 && t.length < 40)
    );
    options.forEach((o) => seen.add(o));

    const match = options.find((o) => o.toLowerCase() === optionText.toLowerCase());
    if (match) {
      await page.locator(`span:text-is("${match}")`).first().click({ timeout: 10000 });
      await page.waitForTimeout(800);
      return;
    }

    // Scroll whatever actually scrolls: walk up from a known option until an
    // ancestor has overflow. The popup markup carries no stable handle.
    const moved = await page.evaluate(() => {
      const anchor = [...document.querySelectorAll("span")].find(
        (s) => s.offsetParent && !s.children.length && /^(Tools|Furniture|Household|Garden|Appliances)$/.test((s.textContent || "").trim())
      );
      let el: HTMLElement | null = (anchor?.parentElement as HTMLElement) ?? null;
      while (el && el.scrollHeight <= el.clientHeight + 4) el = el.parentElement;
      if (!el) return false;
      const before = el.scrollTop;
      el.scrollTop += 220;
      return el.scrollTop !== before;
    });
    await page.waitForTimeout(350);
    if (!moved && i > 3) break;
  }

  throw new Error(
    `"${optionText}" is not an option for ${comboLabel}. Available: ${[...seen].join(", ") || "(none found)"}`
  );
}

/**
 * Optional create-form controls. Same locator style as the rest of this file
 * (role, aria-label, visible text). They come from public descriptions of the
 * desktop create-item form and have NOT been run against a live logged-in page:
 *
 * - Location: `input[role=combobox][aria-label="Location"]` (fallback
 *   `label[role=combobox]` whose text starts "Location"), then a visible
 *   `[role=option]` / `[role=listbox]` suggestion.
 * - More details: `[role=button]` accessible name "More details", or
 *   `span:text-is("More details")`.
 * - Product tags: `textarea[aria-label="Product tags"]` or
 *   `input[aria-label="Product tags"]`, then `label:has-text("Product tags")`
 *   textarea/input. Chips are leaf text or an aria-label containing "remove".
 * - Hide from friends: `[role=switch][aria-label="Hide from friends"]`.
 * - Groups: `[role=checkbox]` on the "List in more places" step (`?step=audience`).
 *   The row text looks like "<name> <N members · Private|Public>".
 * - Paid controls (never clicked): aria-label/text "Boost listing",
 *   "Promote listing", "Promote listing after publish", and the same phrases
 *   with "your"/"this".
 */

const MIN_LOCATION_SCORE = 600;
/** Desktop create form, captured publicly in 2026: product tags cap at 20. */
const PRODUCT_TAG_LIMIT = 20;

interface FormState {
  moreDetailsHandled: boolean;
  moreDetailsMissing: boolean;
}

/** Higher is a closer place. Below MIN_LOCATION_SCORE is not a usable match. */
export function scoreLocationSuggestion(suggestion: string, query: string): number {
  const s = suggestion.toLowerCase().replace(/\s+/g, " ").trim();
  const q = query.toLowerCase().replace(/\s+/g, " ").trim();
  if (!s || !q) return 0;
  if (s === q) return 1000;
  if (s.startsWith(q)) return 900 - Math.min(s.length, 300);
  if (s.includes(q)) return 800 - Math.min(s.length, 200);
  if (q.startsWith(s) && s.length >= 4) return 700;
  const locality = q.split(",")[0].trim();
  if (locality.length >= 3 && s.includes(locality)) return 650;
  return 0;
}

/**
 * Row text on the audience step is the group name glued to its member line,
 * e.g. "Perth Wheels Buy & Sell12.4K members · Public". Returns null for
 * anything that is not a group row.
 */
export function parseGroupName(text: string): string | null {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  const match = flat.match(/^(.*?)\s*(?:(?:private|public)\s*[·•|\u2219-]\s*)?\d[\d.,]*\s*K?\s+members?\b/i);
  if (!match) return null;
  const name = match[1].replace(/[·•|\u2219]\s*$/g, "").trim();
  return name || null;
}

/** Case-insensitive substring, either way, so a partial name still hits. */
export function groupNameMatches(groupName: string, requested: string): boolean {
  const g = groupName.toLowerCase().replace(/\s+/g, " ").trim();
  const r = requested.toLowerCase().replace(/\s+/g, " ").trim();
  if (!g || !r) return false;
  if (g.includes(r)) return true;
  return g.length >= 3 && r.includes(g);
}

/**
 * True for the paid promotion controls on the create / audience steps.
 * Group rows contain "members", so a group is never treated as one of these.
 */
export function isPaidListingControl(label: string): boolean {
  const t = label.replace(/\s+/g, " ").trim().toLowerCase();
  if (!t || t.length > 80) return false;
  if (/\bmembers?\b/.test(t)) return false;
  const phrases = [
    "boost listing",
    "promote listing",
    "promote listing after publish",
    "boost your listing",
    "promote your listing",
    "boost this listing",
    "promote this listing",
    "sponsored listing",
    "paid promotion",
  ];
  if (phrases.some((p) => t === p || t.startsWith(`${p} `) || t.startsWith(`${p}—`) || t.startsWith(`${p}-`) || t.startsWith(`${p}·`))) {
    return true;
  }
  return t === "boost" || t === "promote" || t === "sponsor" || t === "sponsored";
}

function bestLocation(suggestions: string[], query: string): { text: string; score: number } | null {
  let best: { text: string; score: number } | null = null;
  for (const text of suggestions) {
    const score = scoreLocationSuggestion(text, query);
    if (score < MIN_LOCATION_SCORE) continue;
    if (!best || score > best.score || (score === best.score && text.length < best.text.length)) {
      best = { text, score };
    }
  }
  return best;
}

async function moreDetailsControl(page: Page): Promise<Locator | null> {
  const byName = page.getByRole("button", { name: "More details", exact: true });
  if (await byName.count()) return byName.first();
  const span = page.locator('span:text-is("More details")').first();
  if (await span.count()) return span;
  return null;
}

/** Opens More details at most once per listing. A second click would collapse it. */
async function ensureMoreDetails(page: Page, state: FormState): Promise<"ready" | "missing"> {
  if (state.moreDetailsHandled) return state.moreDetailsMissing ? "missing" : "ready";
  const button = await moreDetailsControl(page);
  if (!button) {
    state.moreDetailsHandled = true;
    state.moreDetailsMissing = true;
    return "missing";
  }
  const expanded = await button.getAttribute("aria-expanded");
  if (expanded !== "true") {
    await button.click({ timeout: 8000 });
    await page.waitForTimeout(700);
    const after = await button.getAttribute("aria-expanded");
    if (after === "false") throw new Error('"More details" stayed collapsed after it was clicked.');
  }
  state.moreDetailsHandled = true;
  return "ready";
}

async function findLocationInput(page: Page): Promise<Locator | null> {
  const direct = page.locator('input[role=combobox][aria-label="Location"], input[aria-label="Location"]');
  const n = await direct.count();
  for (let i = 0; i < n; i++) {
    const el = direct.nth(i);
    if (await el.isVisible().catch(() => false)) return el;
  }
  const labels = page.locator("label[role=combobox]");
  const ln = await labels.count();
  for (let i = 0; i < ln; i++) {
    const label = labels.nth(i);
    const text = ((await label.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
    if (!/^location\b/i.test(text)) continue;
    if (!(await label.isVisible().catch(() => false))) continue;
    const input = label.locator("input").first();
    if ((await input.count()) && (await input.isVisible().catch(() => false))) return input;
    return label;
  }
  return null;
}

async function visibleSuggestions(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const shown = (el: Element) => {
      const box = (el as HTMLElement).getBoundingClientRect();
      if (box.width < 2 || box.height < 2) return false;
      const style = getComputedStyle(el);
      return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
    };
    const listboxes = [...document.querySelectorAll('[role="listbox"]')].filter(shown);
    const nodes = listboxes.length
      ? listboxes.flatMap((lb) => [...lb.querySelectorAll('[role="option"], [role="button"]')])
      : [...document.querySelectorAll('[role="option"]')];
    const out: string[] = [];
    for (const node of nodes) {
      if (!shown(node)) continue;
      const text = ((node as HTMLElement).innerText || node.textContent || "").replace(/\s+/g, " ").trim();
      if (!text || text.length > 100 || out.includes(text)) continue;
      out.push(text);
    }
    return out;
  });
}

async function clickSuggestion(page: Page, text: string): Promise<void> {
  if (isPaidListingControl(text)) {
    throw new Error(`Refusing to click "${text}" because it is a Boost, promote, or other paid option.`);
  }
  const options = page.locator('[role=listbox] [role=option], [role=option]');
  const n = await options.count();
  for (let i = 0; i < n; i++) {
    const option = options.nth(i);
    if (!(await option.isVisible().catch(() => false))) continue;
    const label = ((await option.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
    if (label !== text) continue;
    await option.click({ timeout: 8000 });
    return;
  }
  const fallback = page.getByText(text, { exact: true }).first();
  if (await fallback.count()) {
    await fallback.click({ timeout: 8000 });
    return;
  }
  throw new Error(`Could not click location suggestion "${text}".`);
}

async function readLocationShown(page: Page): Promise<string> {
  const input = page.locator('input[role=combobox][aria-label="Location"], input[aria-label="Location"]').first();
  if (await input.count()) {
    const value = (await input.inputValue().catch(() => "")).trim();
    if (value) return value;
  }
  const labels = page.locator("label[role=combobox]");
  const n = await labels.count();
  for (let i = 0; i < n; i++) {
    const text = ((await labels.nth(i).innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
    if (!/^location\b/i.test(text)) continue;
    const shown = text.replace(/^location\b\s*/i, "").trim();
    if (shown && !/^select$/i.test(shown)) return shown;
  }
  return "";
}

async function setLocation(page: Page, state: FormState, query: string): Promise<string> {
  const wanted = query.trim();
  if (!wanted) throw new Error("location is empty, so no place was selected.");

  let input = await findLocationInput(page);
  if (!input) {
    const opened = await ensureMoreDetails(page, state);
    input = await findLocationInput(page);
    if (!input) {
      throw new Error(
        `Location combobox was not on the create form${
          opened === "missing" ? ', and there was no "More details" section to open' : ' after opening "More details"'
        } (now at ${page.url()}).`
      );
    }
  }

  await input.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  await input.click({ timeout: 10000 });
  await input.fill("").catch(() => {});
  if ((await input.inputValue().catch(() => "")).trim()) {
    await input.press("Control+A").catch(() => {});
    await input.press("Meta+A").catch(() => {});
    await input.press("Backspace").catch(() => {});
  }
  await input.pressSequentially(wanted, { delay: 35 });

  let suggestions: string[] = [];
  for (let i = 0; i < 12; i++) {
    suggestions = await visibleSuggestions(page);
    if (suggestions.length) break;
    await page.waitForTimeout(300);
  }
  if (!suggestions.length) {
    throw new Error(
      `No location suggestions appeared for "${wanted}". Nothing was selected. Nothing was published.`
    );
  }
  const best = bestLocation(suggestions, wanted);
  if (!best) {
    throw new Error(
      `"${wanted}" did not match a Location suggestion closely enough. Suggestions: ${suggestions.join(", ")}`
    );
  }
  await clickSuggestion(page, best.text);
  await page.waitForTimeout(600);

  const shown = await readLocationShown(page);
  if (!shown) {
    throw new Error(`Clicked location suggestion "${best.text}", but the Location field is empty afterwards.`);
  }
  const shownNorm = shown.toLowerCase().replace(/\s+/g, " ").trim();
  const chosenNorm = best.text.toLowerCase().replace(/\s+/g, " ").trim();
  const listOpen = await page.evaluate((chosen) => {
    return [...document.querySelectorAll('[role="listbox"]')].some((el) => {
      const box = (el as HTMLElement).getBoundingClientRect();
      const style = getComputedStyle(el);
      if (box.height <= 2 || style.visibility === "hidden" || style.display === "none" || style.opacity === "0") return false;
      return (el.textContent || "").toLowerCase().includes(chosen);
    });
  }, chosenNorm);
  // The suggestion itself is in the field, or the list closed and the field shows a
  // shortened form of that suggestion (often the suburb that was typed).
  const showsSuggestion = shownNorm === chosenNorm || shownNorm.includes(chosenNorm);
  if (listOpen && !showsSuggestion) {
    throw new Error(
      `Clicked location suggestion "${best.text}", but the suggestion list is still open and the Location field shows "${shown}".`
    );
  }
  const accepted = showsSuggestion || (chosenNorm.includes(shownNorm) && scoreLocationSuggestion(shown, wanted) >= MIN_LOCATION_SCORE);
  if (!accepted) {
    throw new Error(`Location field shows "${shown}" after selecting "${best.text}" for "${wanted}".`);
  }
  return shown;
}

async function findTagField(page: Page): Promise<Locator | null> {
  const selectors = [
    'textarea[aria-label="Product tags"]',
    'input[aria-label="Product tags"]',
    '[role=combobox][aria-label="Product tags"]',
    'label:has-text("Product tags") textarea',
    'label:has-text("Product tags") input',
  ];
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if ((await loc.count()) && (await loc.isVisible().catch(() => false))) return loc;
  }
  const labels = page.locator("label");
  const n = await labels.count();
  for (let i = 0; i < n; i++) {
    const label = labels.nth(i);
    const text = ((await label.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
    if (!/^product tags\b/i.test(text)) continue;
    if (!(await label.isVisible().catch(() => false))) continue;
    const inner = label.locator("textarea, input").first();
    if (await inner.count()) return inner;
    return label;
  }
  return null;
}

async function tagVisible(field: Locator, tag: string): Promise<boolean> {
  const needle = tag.trim().toLowerCase();
  return field.evaluate((el, needle) => {
    const norm = (value: string | null | undefined) => (value || "").replace(/\s+/g, " ").trim().toLowerCase();
    const input = el as HTMLInputElement;
    const raw = typeof input.value === "string" ? input.value : el.textContent || "";
    if (raw.split(/[\n,]/).map((part) => part.trim().toLowerCase()).includes(needle)) return true;

    let node: HTMLElement | null = el.parentElement;
    let root: HTMLElement | null = el.parentElement;
    for (let i = 0; i < 5 && node; i++) {
      const text = node.innerText || "";
      if (/product tags/i.test(text) && text.length < 1200) root = node;
      if (text.length > 1200) break;
      node = node.parentElement;
    }
    if (!root) return false;
    for (const candidate of root.querySelectorAll("span, div, a, button")) {
      if (candidate === el || candidate.contains(el)) continue;
      const aria = norm(candidate.getAttribute("aria-label"));
      if (aria.includes(needle) && aria.includes("remove")) return true;
      if (candidate.querySelector("input, textarea, span, div")) continue;
      if (norm(candidate.textContent) === needle) return true;
    }
    return false;
  }, needle);
}

async function productTagLimitReason(field: Locator, addedCount: number): Promise<string | null> {
  const near = await field.evaluate((el) => {
    let node: HTMLElement | null = el.parentElement;
    let best = "";
    for (let i = 0; i < 5 && node; i++) {
      const text = node.innerText || "";
      if (/product tags/i.test(text) && text.length < 1200) best = text;
      if (text.length > 1200) break;
      node = node.parentElement;
    }
    return best;
  });
  const numbered = [
    /you can add up to (\d+) tags/i,
    /maximum of (\d+) tags/i,
    /up to (\d+) product tags/i,
    /(\d+)\s*\/\s*(\d+)\s*tags/i,
  ];
  for (const pattern of numbered) {
    const match = near.match(pattern);
    if (!match) continue;
    const max = Number(match[2] || match[1]);
    const current = match[2] ? Number(match[1]) : addedCount;
    if (Number.isFinite(max) && (addedCount >= max || (match[2] && current >= max))) {
      return `Facebook allows ${max} product tags`;
    }
  }
  if (/can(?:not|'t) add (?:any )?more tags|reached the (?:maximum|limit)|tag limit reached|too many tags/i.test(near)) {
    return "Facebook's product tag limit was reached";
  }
  return null;
}

async function clickExactTagOption(page: Page, tag: string): Promise<boolean> {
  const options = page.locator("[role=option]");
  const n = await options.count();
  const want = tag.trim().toLowerCase();
  for (let i = 0; i < n; i++) {
    const option = options.nth(i);
    if (!(await option.isVisible().catch(() => false))) continue;
    const text = ((await option.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
    if (text.toLowerCase() !== want) continue;
    await option.click({ timeout: 5000 });
    return true;
  }
  return false;
}

async function addProductTags(
  page: Page,
  state: FormState,
  tags: string[]
): Promise<{ added: string[]; notAdded: string[] }> {
  const wanted = tags.map((tag) => tag.trim()).filter(Boolean);
  if (wanted.length === 0) return { added: [], notAdded: [] };

  let field = await findTagField(page);
  if (!field) {
    const opened = await ensureMoreDetails(page, state);
    field = await findTagField(page);
    if (!field) {
      throw new Error(
        `Product tags field was not on the create form${
          opened === "missing" ? ', and there was no "More details" section to open' : ' after opening "More details"'
        } (now at ${page.url()}).`
      );
    }
  }

  const added: string[] = [];
  const notAdded: string[] = [];
  for (let i = 0; i < wanted.length; i++) {
    const tag = wanted[i];
    const capped = added.length >= PRODUCT_TAG_LIMIT ? `Facebook allows ${PRODUCT_TAG_LIMIT} product tags` : null;
    const limit = capped ?? (await productTagLimitReason(field, added.length));
    if (limit) {
      for (const rest of wanted.slice(i)) notAdded.push(`${rest} — ${limit}`);
      break;
    }
    if (await tagVisible(field, tag)) {
      notAdded.push(`${tag} — already on the listing`);
      continue;
    }

    const pending = (await field.inputValue().catch(() => "")).trim();
    const holdsCommittedTags = added.some((existing) => pending.toLowerCase().includes(existing.toLowerCase()) && /[\n,]/.test(pending));
    await field.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
    await field.click({ timeout: 8000 });
    if (!holdsCommittedTags && pending) {
      const cleared = await field.fill("").then(() => true).catch(() => false);
      if (!cleared) {
        await field.press("Control+A").catch(() => {});
        await field.press("Backspace").catch(() => {});
      }
    } else if (holdsCommittedTags) {
      await field.press("End").catch(() => {});
    }
    await field.pressSequentially(tag, { delay: 20 });
    await page.waitForTimeout(350);

    // Enter commits the tag. If a suggestion list is open on a different row,
    // Enter would commit that row, so an exact match is clicked instead.
    const clicked = await clickExactTagOption(page, tag);
    if (!clicked) await field.press("Enter");
    await page.waitForTimeout(450);

    if (await tagVisible(field, tag)) {
      added.push(tag);
      continue;
    }
    const reached = await productTagLimitReason(field, added.length);
    if (reached) {
      for (const rest of wanted.slice(i)) notAdded.push(`${rest} — ${reached}`);
      break;
    }
    throw new Error(
      `Product tag "${tag}" was not added. After typing it and pressing Enter, the Product tags field did not show it. ` +
        `Added so far: ${added.join(", ") || "(none)"}.`
    );
  }

  for (const tag of added) {
    if (!(await tagVisible(field, tag))) {
      throw new Error(`Product tag "${tag}" did not stay on the form after it was entered.`);
    }
  }
  return { added, notAdded };
}

async function findHideSwitch(page: Page): Promise<Locator | null> {
  const exact = page
    .locator('[role=switch][aria-label="Hide from friends"], [role=checkbox][aria-label="Hide from friends"]')
    .first();
  if (await exact.count()) return exact;

  const index = await page.evaluate(() => {
    const switches = [...document.querySelectorAll('[role="switch"]')];
    const span = [...document.querySelectorAll("span")].find(
      (node) => (node.textContent || "").trim() === "Hide from friends" && node.childElementCount === 0
    );
    if (!span) return -1;
    let node: HTMLElement | null = span.parentElement;
    for (let depth = 0; depth < 8 && node; depth++) {
      const text = (node.innerText || "").replace(/\s+/g, " ").trim();
      if (text.length > 160) break;
      const found = [...node.querySelectorAll('[role="switch"]')];
      const labeled = found.find((sw) => (sw.getAttribute("aria-label") || "") === "Hide from friends");
      const pick = labeled || (found.length === 1 ? found[0] : null);
      if (pick && /hide from friends/i.test(text)) {
        const aria = pick.getAttribute("aria-label") || "";
        if (/promote|boost|paid promotion|sponsor/i.test(aria)) return -1;
        if (/promote|boost|paid promotion/i.test(text) && !/hide from friends/i.test(aria)) return -1;
        return switches.indexOf(pick);
      }
      node = node.parentElement;
    }
    return -1;
  });
  if (index < 0) return null;
  return page.locator("[role=switch]").nth(index);
}

async function readSwitch(sw: Locator): Promise<boolean> {
  const aria = await sw.getAttribute("aria-checked");
  if (aria === "true") return true;
  if (aria === "false") return false;
  const checked = await sw.evaluate((el) => {
    const input = el as HTMLInputElement;
    return input.tagName === "INPUT" && typeof input.checked === "boolean" ? input.checked : null;
  });
  if (checked === null) {
    throw new Error('Found "Hide from friends" but could not read whether it is on or off (no aria-checked).');
  }
  return checked;
}

async function setHideFromFriends(page: Page, state: FormState, hide: boolean): Promise<boolean> {
  let sw = await findHideSwitch(page);
  if (!sw) {
    const opened = await ensureMoreDetails(page, state);
    sw = await findHideSwitch(page);
    if (!sw) {
      throw new Error(
        `"Hide from friends" toggle was not on the create form${
          opened === "missing" ? ', and there was no "More details" section to open' : ' after opening "More details"'
        } (now at ${page.url()}).`
      );
    }
  }
  const aria = ((await sw.getAttribute("aria-label")) || "").trim();
  if (isPaidListingControl(aria)) {
    throw new Error(`Refusing to click "${aria}" because it is a Boost, promote, or other paid option.`);
  }

  let current = await readSwitch(sw);
  if (current !== hide) {
    await sw.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
    const visible = await sw.isVisible().catch(() => false);
    if (visible) {
      try {
        await sw.click({ timeout: 8000 });
      } catch {
        await sw.click({ timeout: 8000, force: true });
      }
    } else {
      await sw.click({ timeout: 8000, force: true });
    }
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && current !== hide) {
      await page.waitForTimeout(150);
      current = await readSwitch(sw);
    }
  }
  if (current !== hide) {
    throw new Error(`"Hide from friends" is ${current ? "on" : "off"} after trying to turn it ${hide ? "on" : "off"}.`);
  }
  return current;
}

interface GroupRow {
  index: number;
  name: string;
  checked: boolean;
}

async function readVisibleGroups(page: Page): Promise<GroupRow[]> {
  const boxes = page.locator("[role=checkbox]");
  const n = await boxes.count();
  const rows: GroupRow[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < n; i++) {
    const info = await boxes.nth(i).evaluate((el) => {
      const aria = el.getAttribute("aria-label") || "";
      let label = "";
      let node: HTMLElement | null = el as HTMLElement;
      for (let depth = 0; depth < 6 && node; depth++) {
        const text = (node.innerText || "").replace(/\s+/g, " ").trim();
        if (/members/i.test(text) && text.length < 240) {
          label = text;
          break;
        }
        node = node.parentElement;
      }
      return { aria, label, checked: el.getAttribute("aria-checked") === "true" };
    });
    if (isPaidListingControl(info.aria)) continue;
    const name = parseGroupName(info.label);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    rows.push({ index: i, name, checked: info.checked });
  }
  return rows;
}

async function scrollGroupList(page: Page, toTop: boolean): Promise<boolean> {
  return page.evaluate((toTop) => {
    const box = document.querySelector("[role=checkbox]");
    let el: HTMLElement | null = (box?.parentElement as HTMLElement) ?? null;
    while (el && el.scrollHeight <= el.clientHeight + 4) el = el.parentElement;
    if (!el) return false;
    if (toTop) {
      const before = el.scrollTop;
      el.scrollTop = 0;
      return before !== 0;
    }
    const before = el.scrollTop;
    el.scrollTop += 320;
    return el.scrollTop !== before;
  }, toTop);
}

async function setGroupChecked(page: Page, index: number, name: string, want: boolean): Promise<void> {
  const box = page.locator("[role=checkbox]").nth(index);
  const label = await box.evaluate((el) => {
    let node: HTMLElement | null = el as HTMLElement;
    for (let depth = 0; depth < 6 && node; depth++) {
      const text = (node.innerText || "").replace(/\s+/g, " ").trim();
      if (/members/i.test(text) && text.length < 240) return text;
      node = node.parentElement;
    }
    return "";
  });
  if (parseGroupName(label) !== name) {
    throw new Error(`The group list changed while updating "${name}". Nothing was published.`);
  }
  if ((await box.getAttribute("aria-checked")) === "true" && want) return;
  if ((await box.getAttribute("aria-checked")) !== "true" && !want) return;
  await box.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  try {
    await box.click({ timeout: 8000 });
  } catch (e) {
    throw new Error(`Could not click the checkbox for group "${name}". ${e instanceof Error ? e.message : String(e)}`);
  }
  const deadline = Date.now() + 2000;
  let now = (await box.getAttribute("aria-checked")) === "true";
  while (now !== want && Date.now() < deadline) {
    await page.waitForTimeout(150);
    now = (await box.getAttribute("aria-checked")) === "true";
  }
  if (now !== want) {
    throw new Error(
      `Group "${name}" is ${now ? "ticked" : "not ticked"} after clicking it; expected it to be ${want ? "ticked" : "unticked"}.`
    );
  }
}

async function shareToGroups(
  page: Page,
  requestedRaw: string[]
): Promise<{ ticked: string[]; notFound: string[] }> {
  const requested = requestedRaw.map((name) => name.trim()).filter(Boolean);
  if (requestedRaw.length > 0 && requested.length === 0) {
    throw new Error("share_to_groups was set, but every group name was blank.");
  }

  await scrollGroupList(page, true);
  const appearBy = Date.now() + 5000;
  while (Date.now() < appearBy) {
    if ((await readVisibleGroups(page)).length > 0) break;
    await page.waitForTimeout(400);
  }

  const seen = new Map<string, boolean>();
  let actions = 0;
  for (let pass = 0; pass < 10; pass++) {
    for (;;) {
      const rows = await readVisibleGroups(page);
      const pending = rows.find((row) => requested.some((name) => groupNameMatches(row.name, name)) !== row.checked);
      if (!pending) {
        for (const row of rows) seen.set(row.name, requested.some((name) => groupNameMatches(row.name, name)));
        break;
      }
      if (++actions > 40) {
        throw new Error("Stopped after 40 group checkbox clicks without finishing. Nothing was published.");
      }
      const should = requested.some((name) => groupNameMatches(pending.name, name));
      await setGroupChecked(page, pending.index, pending.name, should);
      seen.set(pending.name, should);
    }
    const moved = await scrollGroupList(page, false);
    await page.waitForTimeout(300);
    if (!moved) break;
  }

  if (seen.size === 0 && requested.length > 0) {
    const samples = await page.evaluate(() =>
      [...document.querySelectorAll('[role="checkbox"]')]
        .slice(0, 8)
        .map((el) => (el.getAttribute("aria-label") || (el as HTMLElement).innerText || "").replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .map((text) => text.slice(0, 90))
    );
    throw new Error(
      `No group checkboxes were found on the "List in more places" step (now at ${page.url()}). ` +
        `Saw: ${samples.join(" | ") || "(no checkboxes)"}. Groups were not changed. Nothing was published.`
    );
  }

  await scrollGroupList(page, true);
  await page.waitForTimeout(300);
  const wrong: string[] = [];
  for (let pass = 0; pass < 10; pass++) {
    const rows = await readVisibleGroups(page);
    for (const row of rows) {
      const should = requested.some((name) => groupNameMatches(row.name, name));
      seen.set(row.name, should);
      if (row.checked !== should) wrong.push(row.name);
    }
    const moved = await scrollGroupList(page, false);
    await page.waitForTimeout(250);
    if (!moved) break;
  }
  if (wrong.length) {
    throw new Error(
      `These groups were not left in the requested state: ${[...new Set(wrong)].join(", ")}. Nothing was published.`
    );
  }

  const ticked = [...seen.entries()].filter(([, on]) => on).map(([name]) => name);
  const notFound = requested.filter((name) => ![...seen.keys()].some((group) => groupNameMatches(group, name)));
  return { ticked, notFound };
}

async function assertAudienceStep(page: Page): Promise<void> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const url = page.url();
    const text = await page.locator("body").innerText().catch(() => "");
    if (url.includes("step=audience") || /list in more places/i.test(text)) return;
    await page.waitForTimeout(400);
  }
  throw new Error(
    `Did not reach the "List in more places" step after Next (now at ${page.url()}). ` +
      `Groups were not changed. Nothing was published.`
  );
}

async function clickFormButton(page: Page, label: "Next" | "Publish"): Promise<void> {
  const button = page.locator(`div[role=button]:has-text("${label}"), span:text-is("${label}")`).first();
  if ((await button.count()) > 0) {
    const aria = ((await button.getAttribute("aria-label")) || "").trim();
    const text = ((await button.innerText().catch(() => "")) || "").trim();
    const accessible = aria || text.split("\n")[0].trim();
    if (isPaidListingControl(accessible)) {
      throw new Error(
        `Refusing to click "${accessible}" because it is a Boost, promote, or other paid option. Nothing was published.`
      );
    }
  }
  await button.click({ timeout: 10000 });
}

/**
 * Fill the whole create form and advance to the review ("List in more places")
 * step. Deliberately STOPS before Publish so the caller can confirm.
 * Returns a PNG screenshot buffer of the review page.
 *
 * Optional location, hide-from-friends, product tags, and group sharing run
 * only when those fields are passed. Boost / promote / paid controls are never
 * clicked.
 */
export async function fillListing(input: ListingInput): Promise<ListingDraft> {
  for (const p of input.photos) {
    if (!fs.existsSync(p)) throw new Error(`Photo not found: ${p}`);
  }
  const page = await getPage();
  await gotoCreate(page);
  await page.waitForTimeout(2500);

  const fileInput = 'input[type=file][accept*="image"]';
  await page.setInputFiles(fileInput, input.photos, { timeout: 20000 });
  await page.waitForTimeout(3500);

  await page.fill('label:has-text("Title") input', input.title, { timeout: 10000 });
  await page.fill('label:has-text("Price") input', String(input.price), { timeout: 10000 });
  await page.fill('label:has-text("Description") textarea', input.description, { timeout: 10000 });

  await pickFromCombobox(page, "Category", input.category);
  await pickFromCombobox(page, "Condition", input.condition);

  const state: FormState = { moreDetailsHandled: false, moreDetailsMissing: false };
  const tagsRequested = (input.productTags ?? []).some((tag) => tag.trim());
  const draft: ListingDraft = {
    screenshot: Buffer.alloc(0),
    tagsAdded: [],
    tagsNotAdded: [],
    groupsTicked: [],
    groupsNotFound: [],
    locationRequested: input.location !== undefined,
    hideRequested: input.hideFromFriends !== undefined,
    tagsRequested,
    groupsRequested: input.shareToGroups !== undefined,
  };

  if (draft.locationRequested || tagsRequested || draft.hideRequested) {
    const needsLocation = draft.locationRequested && !(await findLocationInput(page));
    const needsTags = tagsRequested && !(await findTagField(page));
    const needsHide = draft.hideRequested && !(await findHideSwitch(page));
    if (needsLocation || needsTags || needsHide) await ensureMoreDetails(page, state);
  }

  if (input.location !== undefined) draft.location = await setLocation(page, state, input.location);
  if (tagsRequested && input.productTags) {
    const tags = await addProductTags(page, state, input.productTags);
    draft.tagsAdded = tags.added;
    draft.tagsNotAdded = tags.notAdded;
  }
  if (input.hideFromFriends !== undefined) {
    draft.hideFromFriends = await setHideFromFriends(page, state, input.hideFromFriends);
  }

  // Advance to the audience / review step.
  await clickFormButton(page, "Next");
  await page.waitForTimeout(2500);

  if (input.shareToGroups !== undefined) {
    await assertAudienceStep(page);
    const groups = await shareToGroups(page, input.shareToGroups);
    draft.groupsTicked = groups.ticked;
    draft.groupsNotFound = groups.notFound;
  }

  draft.screenshot = await page.screenshot();
  return draft;
}

/**
 * Fill and publish in one go, for when the seller has already approved the
 * wording and price.
 *
 * Splitting this into fill-then-publish leaves a draft alive only in the open
 * browser, so any interruption between the two loses it. Doing both inside one
 * call removes that window entirely: it either posts or it doesn't.
 *
 * The visual check the two-step flow bought is replaced by a stricter one. The
 * review page is read back and the title and price must appear on it before
 * anything is published, which catches a field that silently failed to fill.
 */
export async function postListing(input: ListingInput): Promise<ListingDraft & { url: string }> {
  const draft = await fillListing(input);

  const page = await getPage();
  const review = await page.innerText("body");
  const priceText = String(input.price).replace(/[^0-9.]/g, "");
  const missing: string[] = [];
  if (!review.includes(input.title.slice(0, 40))) missing.push("title");
  if (priceText && !review.includes(priceText)) missing.push("price");
  if (missing.length) {
    throw new Error(
      `Stopping before publish: the review page does not show the ${missing.join(" or ")} that was asked for. ` +
        `Nothing was posted. Check the form and try again.`
    );
  }

  const url = await publishListing();
  return { ...draft, url };
}

/**
 * Click Publish on the review step. Returns the resulting URL.
 *
 * This only works while the draft from create_listing is still on screen, which
 * holds as long as the server keeps running: both calls share one browser. If
 * the browser has been restarted in between, the draft is gone, and a bare
 * selector timeout would not explain why. Say what happened instead.
 */
export async function publishListing(): Promise<string> {
  const page = await getPage();
  const publish = page.locator('div[role=button]:has-text("Publish"), span:text-is("Publish")').first();
  if ((await publish.count()) === 0) {
    throw new Error(
      "No draft is waiting to be published (currently at " +
        page.url() +
        "). A draft only survives while the browser stays open, so run create_listing again and publish without restarting in between."
    );
  }
  const aria = ((await publish.getAttribute("aria-label")) || "").trim();
  const text = ((await publish.innerText().catch(() => "")) || "").trim();
  const accessible = aria || text.split("\n")[0].trim();
  if (isPaidListingControl(accessible)) {
    throw new Error(
      `Refusing to click "${accessible}" because it is a Boost, promote, or other paid option. Nothing was published.`
    );
  }
  await publish.click({ timeout: 10000 });
  await page.waitForTimeout(5000);
  return page.url();
}

export interface MyListing {
  title: string;
  price: string;
  status: string;
}

/** Read the seller's current listings from the "Selling" page. */
export async function listMine(): Promise<{ text: string; screenshot: Buffer }> {
  const page = await getPage();
  await page.goto(SELLING_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(4000);
  const text = await page.innerText("body");
  const screenshot = await page.screenshot();
  return { text, screenshot };
}
