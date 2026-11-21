import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Stops the same title and price from being published twice.
 *
 * post_listing takes 1-4 minutes, and MCP clients cancel at 60 seconds.
 * The cancelled call used to keep running and click Publish, the caller saw
 * a failure and retried, and the item went up twice. The journal is the
 * shared memory for that: a claim is written before the form is filled, and
 * every lister process on this profile reads it. Separate processes take the
 * lock file beside the journal so the read-modify-write is one step.
 *
 * The file lives beside the profile directory (not inside it) so Chrome's
 * profile data and this record do not share a folder.
 */

const DEFAULT_DUPLICATE_WINDOW_MS = 6 * 60 * 60 * 1000;
const LOCK_WAIT_MS = 10_000;
const LOCK_STALE_MS = 30_000;

export type PublishClaimStatus = "in_progress" | "published" | "unconfirmed" | "failed";
export type SettledPublishStatus = "published" | "unconfirmed" | "failed";

export interface PublishClaim {
  id: string;
  title: string;
  price: string;
  titleKey: string;
  priceKey: string;
  status: PublishClaimStatus;
  /** Epoch milliseconds of the claim, replaced when the claim is settled. */
  at: number;
  url?: string;
}

export class DuplicateListingError extends Error {
  readonly blockingStatus: "in_progress" | "published" | "unconfirmed";

  constructor(message: string, blockingStatus: "in_progress" | "published" | "unconfirmed") {
    super(message);
    this.name = "DuplicateListingError";
    this.blockingStatus = blockingStatus;
  }
}

/** publish-journal.json next to the profile directory, not inside it. */
export function publishJournalPath(profileDirectory: string): string {
  return path.join(path.dirname(profileDirectory), "publish-journal.json");
}

export function duplicateWindowMs(): number {
  return readMs("FB_MCP_DUPLICATE_WINDOW_MS", DEFAULT_DUPLICATE_WINDOW_MS);
}

export function publishConfirmMs(): number {
  return readMs("FB_MCP_PUBLISH_CONFIRM_MS", 90_000);
}

export function normalizeTitle(title: string): string {
  return String(title).normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

/** "$50", "50", "50.00", and "1,120" share a key. A different number does not. */
export function normalizePrice(price: string | number): string {
  if (typeof price === "number" && Number.isFinite(price)) return price.toFixed(2);
  const cleaned = String(price).replace(/[$,\s]/g, "");
  const match = cleaned.match(/-?\d+(?:\.\d+)?/);
  if (!match) return cleaned.toLowerCase();
  const value = Number(match[0]);
  if (!Number.isFinite(value)) return cleaned.toLowerCase();
  return value.toFixed(2);
}

/**
 * Reserve this title and price. Throws DuplicateListingError when the same
 * normalized pair is in progress, published, or unconfirmed inside the
 * duplicate window. Failed claims do not block. Entries older than the window
 * are ignored. allowDuplicate skips the refusal and still records a claim.
 */
export function claimPublish(
  journalPath: string,
  title: string,
  price: string | number,
  allowDuplicate = false
): PublishClaim {
  const titleKey = normalizeTitle(title);
  const priceKey = normalizePrice(price);
  return withJournalLock(journalPath, () => {
    const journal = readJournal(journalPath);
    if (!allowDuplicate) {
      const blocker = blockingEntry(journal.entries, titleKey, priceKey, duplicateWindowMs());
      if (blocker) {
        throw new DuplicateListingError(duplicateMessage(blocker), blocker.status as DuplicateListingError["blockingStatus"]);
      }
    }
    const claim: PublishClaim = {
      id: randomUUID(),
      title: String(title),
      price: String(price),
      titleKey,
      priceKey,
      status: "in_progress",
      at: Date.now(),
    };
    journal.entries.push(claim);
    writeJournal(journalPath, journal);
    return claim;
  });
}

/** Record how a claim ended. `failed` leaves the title and price free to try again. */
export function settlePublish(
  journalPath: string,
  claim: PublishClaim,
  status: SettledPublishStatus,
  url?: string
): void {
  if (status !== "published" && status !== "unconfirmed" && status !== "failed") {
    throw new Error(`Unknown publish result "${status}"`);
  }
  withJournalLock(journalPath, () => {
    const journal = readJournal(journalPath);
    const index = journal.entries.findIndex((entry) => entry.id === claim.id);
    if (index < 0) {
      throw new Error(`Publish claim ${claim.id} is not in ${journalPath}`);
    }
    const current = journal.entries[index];
    journal.entries[index] = {
      ...current,
      status,
      at: Date.now(),
      ...(url ? { url } : {}),
    };
    writeJournal(journalPath, journal);
  });
}

function readMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function blockingEntry(
  entries: PublishClaim[],
  titleKey: string,
  priceKey: string,
  windowMs: number
): PublishClaim | undefined {
  const now = Date.now();
  const fresh = entries.filter((entry) => {
    if (entry.titleKey !== titleKey || entry.priceKey !== priceKey) return false;
    if (entry.status === "failed") return false;
    if (now - entry.at > windowMs) return false;
    return entry.status === "in_progress" || entry.status === "published" || entry.status === "unconfirmed";
  });
  return (
    fresh.find((entry) => entry.status === "in_progress") ??
    fresh.find((entry) => entry.status === "unconfirmed") ??
    fresh.find((entry) => entry.status === "published")
  );
}

function duplicateMessage(entry: PublishClaim): string {
  const label = `"${entry.title}" at ${entry.price}`;
  if (entry.status === "in_progress") {
    return (
      `A listing for ${label} is already in progress. Nothing was published for this call. ` +
      `Wait for that attempt to finish, then check list_my_listings. ` +
      `Posts take 1-4 minutes; set toolTimeoutSec to about 600. Never retry a timed-out call while another attempt is still running.`
    );
  }
  if (entry.status === "unconfirmed") {
    return (
      `A listing for ${label} is unconfirmed — check list_my_listings, do not retry. ` +
      `Publish was already clicked and may have gone through. Nothing was published for this call. ` +
      `Pass allow_duplicate only when a second copy is intentional.`
    );
  }
  const where = entry.url ? ` Now at: ${entry.url}.` : "";
  return (
    `A listing for ${label} was already published within the duplicate window.${where} ` +
    `Nothing was published for this call. Check list_my_listings. Do not retry a timed-out post_listing. ` +
    `Pass allow_duplicate only when a second copy is intentional.`
  );
}

interface JournalFile {
  entries: PublishClaim[];
}

function isClaim(value: unknown): value is PublishClaim {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === "string" &&
    typeof entry.title === "string" &&
    typeof entry.price === "string" &&
    typeof entry.titleKey === "string" &&
    typeof entry.priceKey === "string" &&
    (entry.status === "in_progress" ||
      entry.status === "published" ||
      entry.status === "unconfirmed" ||
      entry.status === "failed") &&
    typeof entry.at === "number" &&
    Number.isFinite(entry.at)
  );
}

function readJournal(journalPath: string): JournalFile {
  if (!fs.existsSync(journalPath)) return { entries: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  } catch (err) {
    throw new Error(
      `Could not read the publish journal at ${journalPath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Publish journal at ${journalPath} must be a JSON object.`);
  }
  const entries = (parsed as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) {
    throw new Error(`Publish journal at ${journalPath} is missing an entries array.`);
  }
  return { entries: entries.filter(isClaim) };
}

function writeJournal(journalPath: string, journal: JournalFile): void {
  fs.mkdirSync(path.dirname(journalPath), { recursive: true });
  const tmp = `${journalPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(journal, null, 2)}\n`);
  try {
    fs.renameSync(tmp, journalPath);
  } catch {
    try {
      fs.copyFileSync(tmp, journalPath);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function lockPid(lockPath: string): number | null {
  try {
    const pid = Number(fs.readFileSync(lockPath, "utf8").split("\n")[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** Drop a lock whose owner is gone, or one that has been held far longer than a journal write takes. */
function reclaimStaleLock(lockPath: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(lockPath);
  } catch {
    return;
  }
  const pid = lockPid(lockPath);
  const abandoned = pid == null || !processAlive(pid) || Date.now() - stat.mtimeMs > LOCK_STALE_MS;
  if (!abandoned) return;
  try {
    fs.unlinkSync(lockPath);
  } catch {
    /* the owner released it, or another waiter already reclaimed it */
  }
}

function releaseLock(lockPath: string, token: string): void {
  try {
    if (!fs.readFileSync(lockPath, "utf8").includes(token)) return;
  } catch {
    return;
  }
  try {
    fs.unlinkSync(lockPath);
  } catch {
    /* already removed */
  }
}

function withJournalLock<T>(journalPath: string, fn: () => T): T {
  fs.mkdirSync(path.dirname(journalPath), { recursive: true });
  const lockPath = `${journalPath}.lock`;
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  let fd: number | null = null;
  while (fd === null) {
    try {
      fd = fs.openSync(lockPath, "wx");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      reclaimStaleLock(lockPath);
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for the publish journal lock at ${lockPath}`);
      }
      sleepSync(20);
    }
  }
  try {
    fs.writeSync(fd, `${process.pid}\n${token}\n`);
    return fn();
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* the fd is already closed */
    }
    releaseLock(lockPath, token);
  }
}
