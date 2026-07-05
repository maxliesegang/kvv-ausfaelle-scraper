import { join } from 'node:path';
import type { Cancellation } from './types.js';
import { readJsonFile, writeJsonFile } from './utils/fs.js';
import { getFahrplanYear } from './fahrplan.js';

/** Records written before cause classification existed have no `cause` field. */
type StoredCancellation = Omit<Cancellation, 'cause'> & { cause?: Cancellation['cause'] };

/**
 * Loads existing cancellation data from a JSON file.
 * Returns empty array if file doesn't exist or cannot be parsed.
 *
 * Records written before cause classification lack a `cause` field. Their cause cannot
 * be recomputed (the source article text is not stored), so they are stamped `unknown`
 * to honestly reflect that while satisfying the now-required field.
 */
export async function loadExistingCancellations(filePath: string): Promise<Cancellation[]> {
  try {
    const data = await readJsonFile<StoredCancellation[]>(filePath);
    if (data && Array.isArray(data)) {
      return data.map((entry) => ({ ...entry, cause: entry.cause ?? 'unknown' }));
    }
  } catch (error) {
    console.warn('Failed to read/parse existing file', filePath, error);
  }
  return [];
}

/**
 * Trip identity used for dedup, cause updates, and reconciliation: `date|trainNumber|fromTime`.
 * Exported so offline tooling (e.g. `scripts/reparse-archives.ts`) diffs against exactly the
 * same key the live store uses, instead of maintaining a hand-synced copy.
 */
export function getCancellationKey(cancellation: Cancellation): string {
  return `${cancellation.date}|${cancellation.trainNumber}|${cancellation.fromTime}`;
}

/**
 * Comparator that orders cancellations deterministically for stable file output.
 */
function compareCancellations(a: Cancellation, b: Cancellation): number {
  return (
    a.date.localeCompare(b.date) ||
    a.fromTime.localeCompare(b.fromTime) ||
    a.trainNumber.localeCompare(b.trainNumber)
  );
}

interface BucketStats {
  /** Trips newly stored this run (not previously present). */
  addedTrips: Cancellation[];
  /** Count of incoming trips that were already stored unchanged. */
  duplicates: number;
  /** Stored trips whose cause a re-parse reclassified this run. */
  updatedTrips: Cancellation[];
  /** Stored trips dropped this run because their source article no longer lists them. */
  removedTrips: Cancellation[];
}

/** One-line, human-readable identity of a trip for run logs. */
function formatTrip(trip: Cancellation): string {
  return `${trip.line} ${trip.trainNumber} ${trip.date} ${trip.fromTime}→${trip.toTime} ${trip.fromStop}→${trip.toStop}`;
}

interface CancellationBucket {
  readonly filePath: string;
  /** Stored entries keyed by trip identity — the single store dedup, cause updates, and
   *  ghost-pruning all operate on. */
  readonly entries: Map<string, Cancellation>;
  /** Keys of every trip this run produced for this bucket (added, updated, and duplicate alike). */
  readonly freshKeys: Set<string>;
  stats: BucketStats;
}

/** A bucket before its existing file is loaded: this run's trips plus their target path. */
interface PendingBucket {
  readonly filePath: string;
  readonly freshTrips: Cancellation[];
}

/** Resolves the Fahrplan (timetable) year a date belongs to, or throws if unknown. */
function resolveFahrplanYear(date: string): string {
  const year = getFahrplanYear(date);
  if (year === undefined) {
    throw new Error(
      `Cannot determine Fahrplan year for date ${date}. ` +
        `This date may be outside of known Fahrplan periods. ` +
        `Please update the Fahrplan definitions in src/fahrplan.ts.`,
    );
  }
  return String(year);
}

/**
 * Groups trips by their destination file (`<year>/<line>.json`). Pure — performs no
 * I/O — so grouping (and any bad-date error) happens before a single file is touched.
 */
function groupTripsIntoBuckets(baseDir: string, trips: Cancellation[]): PendingBucket[] {
  const pendingByPath = new Map<string, PendingBucket>();

  for (const trip of trips) {
    const year = resolveFahrplanYear(trip.date);
    const filePath = join(baseDir, year, `${trip.line}.json`);
    let pending = pendingByPath.get(filePath);
    if (!pending) {
      pending = { filePath, freshTrips: [] };
      pendingByPath.set(filePath, pending);
    }
    pending.freshTrips.push(trip);
  }

  return [...pendingByPath.values()];
}

/** Loads a bucket's existing file, merges this run's trips into it, and prunes ghosts. */
async function buildBucket(
  pending: PendingBucket,
  refetchedSourceUrls: ReadonlySet<string>,
): Promise<CancellationBucket> {
  const loaded = await loadExistingCancellations(pending.filePath);
  const bucket: CancellationBucket = {
    filePath: pending.filePath,
    entries: new Map(loaded.map((entry) => [getCancellationKey(entry), entry])),
    freshKeys: new Set(),
    stats: { addedTrips: [], duplicates: 0, updatedTrips: [], removedTrips: [] },
  };

  for (const trip of pending.freshTrips) {
    mergeTrip(bucket, trip);
  }
  reconcileBucket(bucket, refetchedSourceUrls);

  return bucket;
}

/**
 * Merges a trip into a bucket, tracking whether it was added, reclassified, or an
 * unchanged duplicate.
 *
 * When the same trip is re-parsed this run, the fresh parse reflects the article's
 * current text and is authoritative, so its cause overwrites the stored one. This lets
 * a classifier improvement (or an article KVV re-attributes to a concrete cause) turn a
 * previously stored `unknown` into a real cause instead of leaving it stuck forever.
 */
function mergeTrip(bucket: CancellationBucket, trip: Cancellation): void {
  const tripKey = getCancellationKey(trip);
  bucket.freshKeys.add(tripKey);

  const existing = bucket.entries.get(tripKey);
  if (existing === undefined) {
    bucket.entries.set(tripKey, trip);
    bucket.stats.addedTrips.push(trip);
    return;
  }

  if (existing.cause === trip.cause) {
    bucket.stats.duplicates += 1;
    return;
  }

  const updated = { ...existing, cause: trip.cause };
  bucket.entries.set(tripKey, updated);
  bucket.stats.updatedTrips.push(updated);
}

/**
 * Drops stored entries that disappeared from their source article this run.
 *
 * KVV edits detail pages in place — sometimes without bumping their `Stand`
 * timestamp — so a trip stored from an earlier version of an article can
 * silently vanish from the current version, leaving a "ghost" in our data.
 * For every article we successfully re-fetched this run (`refetchedSourceUrls`),
 * we treat its fresh trip set as authoritative: a stored entry from that same
 * article that was not seen again is stale and gets removed.
 *
 * Entries from articles we did *not* re-fetch this run — transient fetch
 * failures, articles skipped as too young, or simply unrelated articles — are
 * never in `refetchedSourceUrls`, so they are always kept. This makes pruning
 * safe: a hiccup fetching one article can never delete its stored data.
 *
 * Scope: reconciliation only sees buckets loaded for this run's trips. If a
 * revised article drops *every* trip on one of its lines, that line's bucket is
 * not loaded and its ghost survives until the bucket is touched again. The
 * common case (an article that keeps listing trips on the same lines) is fully
 * covered.
 */
function reconcileBucket(
  bucket: CancellationBucket,
  refetchedSourceUrls: ReadonlySet<string>,
): void {
  for (const [key, entry] of bucket.entries) {
    const isGhost = refetchedSourceUrls.has(entry.sourceUrl) && !bucket.freshKeys.has(key);
    if (isGhost) {
      bucket.entries.delete(key);
      bucket.stats.removedTrips.push(entry);
    }
  }
}

/**
 * Writes a bucket to disk, creating necessary directories.
 */
async function writeBucket(bucket: CancellationBucket): Promise<void> {
  const { filePath, stats } = bucket;
  const entries = [...bucket.entries.values()].sort(compareCancellations);
  await writeJsonFile(filePath, entries);
  console.log(
    'Updated',
    filePath,
    `(added: ${stats.addedTrips.length}, updated: ${stats.updatedTrips.length}, ` +
      `duplicates: ${stats.duplicates}, removed: ${stats.removedTrips.length}, ` +
      `total: ${entries.length})`,
  );
  for (const trip of stats.addedTrips) {
    console.log('  + added  ', formatTrip(trip));
  }
  for (const trip of stats.updatedTrips) {
    console.log('  ~ updated', formatTrip(trip), `→ ${trip.cause}`);
  }
  for (const trip of stats.removedTrips) {
    console.log('  - removed', formatTrip(trip));
  }
}

function summarizeBuckets(buckets: Iterable<CancellationBucket>): {
  added: number;
  updated: number;
  duplicates: number;
  removed: number;
} {
  let added = 0;
  let updated = 0;
  let duplicates = 0;
  let removed = 0;

  for (const bucket of buckets) {
    added += bucket.stats.addedTrips.length;
    updated += bucket.stats.updatedTrips.length;
    duplicates += bucket.stats.duplicates;
    removed += bucket.stats.removedTrips.length;
  }

  return { added, updated, duplicates, removed };
}

/**
 * Saves cancellations to JSON files, organized by year and line.
 * Merges with existing data and reports statistics.
 */
export async function saveCancellations(baseDir: string, trips: Cancellation[]): Promise<void> {
  // Articles we successfully re-fetched this run; their fresh trip set is authoritative.
  const refetchedSourceUrls = new Set(trips.map((trip) => trip.sourceUrl));

  // Group by destination file first (pure), then load + merge + write each in parallel.
  const pendingBuckets = groupTripsIntoBuckets(baseDir, trips);
  const buckets = await Promise.all(
    pendingBuckets.map((pending) => buildBucket(pending, refetchedSourceUrls)),
  );
  await Promise.all(buckets.map(writeBucket));

  const totals = summarizeBuckets(buckets);
  console.log(
    `Summary: added ${totals.added} new cancellations, ` +
      `updated ${totals.updated} causes, ` +
      `skipped ${totals.duplicates} duplicates, removed ${totals.removed} stale entries.`,
  );
}
