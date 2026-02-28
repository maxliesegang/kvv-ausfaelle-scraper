import { join } from 'node:path';
import type { Cancellation } from './types.js';
import { readJsonFile, writeJsonFile } from './utils/fs.js';
import { getFahrplanYear } from './fahrplan.js';

/**
 * Loads existing cancellation data from a JSON file.
 * Returns empty array if file doesn't exist or cannot be parsed.
 */
export async function loadExisting(filePath: string): Promise<Cancellation[]> {
  try {
    const data = await readJsonFile<Cancellation[]>(filePath);
    if (data && Array.isArray(data)) {
      return data;
    }
  } catch (error) {
    console.warn('Failed to read/parse existing file', filePath, error);
  }
  return [];
}

function getCancellationKey(cancellation: Cancellation): string {
  return `${cancellation.date}|${cancellation.trainNumber}|${cancellation.fromTime}`;
}

/**
 * Sorts cancellations deterministically for consistent output.
 */
function sortDeterministic(a: Cancellation, b: Cancellation): number {
  return (
    a.date.localeCompare(b.date) ||
    a.fromTime.localeCompare(b.fromTime) ||
    a.trainNumber.localeCompare(b.trainNumber)
  );
}

interface BucketStats {
  added: number;
  duplicates: number;
}

interface CancellationBucket {
  readonly key: string;
  readonly year: string;
  readonly line: string;
  readonly filePath: string;
  readonly seenKeys: Set<string>;
  entries: Cancellation[];
  stats: BucketStats;
}

/**
 * Creates a unique key for bucketing cancellations by year and line.
 */
function bucketKey(year: string, line: string): string {
  return `${year}/${line}`;
}

/**
 * Finds or creates a bucket for the given trip, loading existing data if necessary.
 */
async function findOrCreateBucket(
  buckets: Map<string, CancellationBucket>,
  baseDir: string,
  trip: Cancellation,
): Promise<CancellationBucket> {
  const fahrplanYear = getFahrplanYear(trip.date);
  if (fahrplanYear === undefined) {
    throw new Error(
      `Cannot determine Fahrplan year for date ${trip.date}. ` +
        `This date may be outside of known Fahrplan periods. ` +
        `Please update the Fahrplan definitions in src/fahrplan.ts.`,
    );
  }
  const year = String(fahrplanYear);
  const line = trip.line;
  const key = bucketKey(year, line);

  let bucket = buckets.get(key);
  if (!bucket) {
    const filePath = join(baseDir, year, `${line}.json`);
    const entries = await loadExisting(filePath);
    bucket = {
      key,
      year,
      line,
      filePath,
      seenKeys: new Set(entries.map((entry) => getCancellationKey(entry))),
      entries,
      stats: { added: 0, duplicates: 0 },
    };
    buckets.set(key, bucket);
  }
  return bucket;
}

/**
 * Merges a trip into a bucket, tracking whether it was added or was a duplicate.
 */
function mergeTrip(bucket: CancellationBucket, trip: Cancellation): void {
  const tripKey = getCancellationKey(trip);
  if (bucket.seenKeys.has(tripKey)) {
    bucket.stats.duplicates += 1;
    return;
  }

  bucket.seenKeys.add(tripKey);
  bucket.entries.push(trip);
  bucket.stats.added += 1;
}

/**
 * Writes a bucket to disk, creating necessary directories.
 */
async function writeBucket(bucket: CancellationBucket): Promise<void> {
  const { filePath, entries, stats } = bucket;
  entries.sort(sortDeterministic);
  await writeJsonFile(filePath, entries);
  console.log('Updated', filePath, `(added: ${stats.added}, duplicates: ${stats.duplicates})`);
}

function summarizeBuckets(buckets: Iterable<CancellationBucket>): BucketStats {
  let added = 0;
  let duplicates = 0;

  for (const bucket of buckets) {
    added += bucket.stats.added;
    duplicates += bucket.stats.duplicates;
  }

  return { added, duplicates };
}

/**
 * Saves cancellations to JSON files, organized by year and line.
 * Merges with existing data and reports statistics.
 */
export async function saveCancellations(baseDir: string, trips: Cancellation[]): Promise<void> {
  const buckets = new Map<string, CancellationBucket>();

  // Group trips into buckets and merge with existing data
  for (const trip of trips) {
    const bucket = await findOrCreateBucket(buckets, baseDir, trip);
    mergeTrip(bucket, trip);
  }

  // Write all buckets to disk
  await Promise.all(Array.from(buckets.values()).map((bucket) => writeBucket(bucket)));

  // Report summary statistics
  const totals = summarizeBuckets(buckets.values());

  console.log(
    `Summary: added ${totals.added} new cancellations, skipped ${totals.duplicates} duplicates.`,
  );
}
