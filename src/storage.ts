import { join } from 'node:path';
import type { Cancellation } from './types.js';
import { readJsonFile, writeJsonFile } from './utils/fs.js';
import { getFahrplanYear } from './fahrplan.js';

/**
 * Older records lack fields added over time: `cause` (pre-classification) and `causeKeyword`
 * (pre-evidence). Both are optional on disk and backfilled on load.
 */
type StoredCancellation = Omit<Cancellation, 'cause' | 'causeKeyword'> & {
  cause?: Cancellation['cause'];
  causeKeyword?: Cancellation['causeKeyword'];
};

/**
 * Loads existing cancellation data from a JSON file.
 * Returns empty array if file doesn't exist or cannot be parsed.
 *
 * Records written before cause classification lack a `cause` field. Their cause cannot
 * be recomputed (the source article text is not stored, only archived when available), so
 * they are stamped `unknown` to honestly reflect that while satisfying the now-required
 * field. `causeKeyword` defaults to `null` for the same reason.
 */
export async function loadExistingCancellations(filePath: string): Promise<Cancellation[]> {
  try {
    const data = await readJsonFile<StoredCancellation[]>(filePath);
    if (data && Array.isArray(data)) {
      return data.map((entry) => ({
        ...entry,
        cause: entry.cause ?? 'unknown',
        causeKeyword: entry.causeKeyword ?? null,
      }));
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
 * Exported so maintenance scripts produce the same ordering as the live store.
 */
export function compareCancellationsBySchedule(a: Cancellation, b: Cancellation): number {
  return (
    a.date.localeCompare(b.date) ||
    a.fromTime.localeCompare(b.fromTime) ||
    a.trainNumber.localeCompare(b.trainNumber)
  );
}

interface CancellationBucketStats {
  /** Trips newly stored this run (not previously present). */
  addedTrips: Cancellation[];
  /** Count of incoming trips that were already stored unchanged. */
  duplicates: number;
  /** Stored trips whose cause or evidence keyword changed this run. */
  classificationUpdatedTrips: Cancellation[];
  /** Stored trips dropped this run because their source article no longer lists them. */
  removedTrips: Cancellation[];
}

/** One-line, human-readable identity of a trip for run logs. */
function formatTrip(trip: Cancellation): string {
  return `${trip.line} ${trip.trainNumber} ${trip.date} ${trip.fromTime}→${trip.toTime} ${trip.fromStop}→${trip.toStop}`;
}

interface CancellationBucket {
  readonly filePath: string;
  /** Stored trips keyed by trip identity — the single store dedup, classification updates, and
   *  ghost-pruning all operate on. */
  readonly tripsByKey: Map<string, Cancellation>;
  /** Keys of every trip this run produced for this bucket (added, updated, and duplicate alike). */
  readonly refetchedTripKeys: Set<string>;
  stats: CancellationBucketStats;
}

/** A bucket before its existing file is loaded: this run's trips plus their target path. */
interface PendingCancellationBucket {
  readonly filePath: string;
  readonly refetchedTrips: Cancellation[];
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
function groupTripsIntoBuckets(
  baseDir: string,
  trips: Cancellation[],
): PendingCancellationBucket[] {
  const pendingBucketsByPath = new Map<string, PendingCancellationBucket>();

  for (const trip of trips) {
    const year = resolveFahrplanYear(trip.date);
    const filePath = join(baseDir, year, `${trip.line}.json`);
    let pendingBucket = pendingBucketsByPath.get(filePath);
    if (!pendingBucket) {
      pendingBucket = { filePath, refetchedTrips: [] };
      pendingBucketsByPath.set(filePath, pendingBucket);
    }
    pendingBucket.refetchedTrips.push(trip);
  }

  return [...pendingBucketsByPath.values()];
}

/** Loads a bucket's existing file, merges this run's trips into it, and prunes ghosts. */
async function buildBucket(
  pendingBucket: PendingCancellationBucket,
  refetchedSourceUrls: ReadonlySet<string>,
): Promise<CancellationBucket> {
  const storedTrips = await loadExistingCancellations(pendingBucket.filePath);
  const bucket: CancellationBucket = {
    filePath: pendingBucket.filePath,
    tripsByKey: new Map(storedTrips.map((trip) => [getCancellationKey(trip), trip])),
    refetchedTripKeys: new Set(),
    stats: {
      addedTrips: [],
      duplicates: 0,
      classificationUpdatedTrips: [],
      removedTrips: [],
    },
  };

  for (const trip of pendingBucket.refetchedTrips) {
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
  bucket.refetchedTripKeys.add(tripKey);

  const storedTrip = bucket.tripsByKey.get(tripKey);
  if (storedTrip === undefined) {
    bucket.tripsByKey.set(tripKey, trip);
    bucket.stats.addedTrips.push(trip);
    return;
  }

  if (storedTrip.cause === trip.cause && storedTrip.causeKeyword === trip.causeKeyword) {
    bucket.stats.duplicates += 1;
    return;
  }

  // Classification changed on a re-fetch — update both fields so the category and its
  // evidence never drift. This includes evidence-only refinements within the same category.
  const classificationUpdatedTrip = {
    ...storedTrip,
    cause: trip.cause,
    causeKeyword: trip.causeKeyword,
  };
  bucket.tripsByKey.set(tripKey, classificationUpdatedTrip);
  bucket.stats.classificationUpdatedTrips.push(classificationUpdatedTrip);
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
  for (const [tripKey, storedTrip] of bucket.tripsByKey) {
    const isGhost =
      refetchedSourceUrls.has(storedTrip.sourceUrl) && !bucket.refetchedTripKeys.has(tripKey);
    if (isGhost) {
      bucket.tripsByKey.delete(tripKey);
      bucket.stats.removedTrips.push(storedTrip);
    }
  }
}

/**
 * Writes a bucket to disk, creating necessary directories.
 */
async function writeBucket(bucket: CancellationBucket): Promise<void> {
  const { filePath, stats } = bucket;
  const trips = [...bucket.tripsByKey.values()].sort(compareCancellationsBySchedule);
  await writeJsonFile(filePath, trips);
  console.log(
    'Updated',
    filePath,
    `(added: ${stats.addedTrips.length}, classifications updated: ` +
      `${stats.classificationUpdatedTrips.length}, ` +
      `duplicates: ${stats.duplicates}, removed: ${stats.removedTrips.length}, ` +
      `total: ${trips.length})`,
  );
  for (const trip of stats.addedTrips) {
    console.log('  + added  ', formatTrip(trip));
  }
  for (const trip of stats.classificationUpdatedTrips) {
    console.log('  ~ updated', formatTrip(trip), `→ ${trip.cause}`);
  }
  for (const trip of stats.removedTrips) {
    console.log('  - removed', formatTrip(trip));
  }
}

function summarizeBuckets(buckets: Iterable<CancellationBucket>): {
  tripsAdded: number;
  classificationsUpdated: number;
  duplicateTrips: number;
  staleTripsRemoved: number;
} {
  let tripsAdded = 0;
  let classificationsUpdated = 0;
  let duplicateTrips = 0;
  let staleTripsRemoved = 0;

  for (const bucket of buckets) {
    tripsAdded += bucket.stats.addedTrips.length;
    classificationsUpdated += bucket.stats.classificationUpdatedTrips.length;
    duplicateTrips += bucket.stats.duplicates;
    staleTripsRemoved += bucket.stats.removedTrips.length;
  }

  return { tripsAdded, classificationsUpdated, duplicateTrips, staleTripsRemoved };
}

/**
 * Saves cancellations to JSON files, organized by year and line.
 * Merges with existing data and reports statistics.
 */
export async function saveCancellations(baseDir: string, trips: Cancellation[]): Promise<void> {
  // Articles we successfully re-fetched this run; their refetched trip set is authoritative.
  const refetchedSourceUrls = new Set(trips.map((trip) => trip.sourceUrl));

  // Group by destination file first (pure), then load + merge + write each in parallel.
  const pendingBuckets = groupTripsIntoBuckets(baseDir, trips);
  const buckets = await Promise.all(
    pendingBuckets.map((pendingBucket) => buildBucket(pendingBucket, refetchedSourceUrls)),
  );
  await Promise.all(buckets.map(writeBucket));

  const totals = summarizeBuckets(buckets);
  console.log(
    `Summary: added ${totals.tripsAdded} new cancellations, ` +
      `updated ${totals.classificationsUpdated} classifications, ` +
      `skipped ${totals.duplicateTrips} duplicates, ` +
      `removed ${totals.staleTripsRemoved} stale entries.`,
  );
}
