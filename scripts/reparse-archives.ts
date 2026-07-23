#!/usr/bin/env tsx
/**
 * Reparse the archived article texts and diff the result against the stored cancellations.
 *
 * The per-article text archive (`docs/<year>/articles/<detailID>.txt`, written by
 * `src/article-archive.ts`) preserves the exact wording KVV published — including versions
 * it has since edited away on the live site. Feeding those bodies back through the current
 * parser shows what today's parser + cause classifier would make of them, which surfaces:
 *   - parser/classifier *improvements* (archive now yields trips or a cause the stored data
 *     lacks), and
 *   - parser *regressions* (archive no longer yields trips that are stored).
 *
 * By default this is a read-only report — it writes nothing. It is the offline counterpart to
 * a live scraper run: same parsing, but against the frozen archive instead of the network.
 *
 * With `--write` it also *backfills*: for every stored trip whose source article is archived,
 * it re-stamps `cause` + `causeKeyword` with what the current classifier makes of the archived
 * text. This is how a cause-taxonomy change reaches history — but only as far as the archive
 * reaches. Trips whose article was never archived (most of the pre-archive backlog) keep their
 * stored cause; only `cause`/`causeKeyword` are touched, never trip identity (no add/remove).
 *
 * Usage:
 *   npm run reparse-archives                # all Fahrplan years under docs/ (report only)
 *   npm run reparse-archives -- --year=2026 # only that year's archives
 *   npm run reparse-archives -- --verbose   # list every differing trip, not just counts
 *   npm run reparse-archives -- --write     # re-stamp cause/causeKeyword on archived trips
 *   npm run reparse-archives -- --write-trips # reconcile stored trips from parsed archives
 *
 * Exit code is 0 regardless of findings. Pipe/read the summary to act on it.
 */

import { basename, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { DATA_DIR } from '../src/config.js';
import {
  compareCancellationsBySchedule,
  getCancellationKey,
  loadExistingCancellations,
} from '../src/storage.js';
import { parseDetailPage, ParseError } from '../src/parser/index.js';
import { ARCHIVE_SUBDIR, parseArchive } from '../src/article-archive.js';
import { listFahrplanYearDirectories } from '../src/fahrplan.js';
import { listFiles, readTextFile, writeJsonFile } from '../src/utils/fs.js';
import type { CauseClassification } from '../src/cause.js';
import type { Cancellation } from '../src/types.js';

/** One-line, human-readable identity of a trip for the diff report. */
function formatTrip(trip: Cancellation): string {
  return `${trip.line} ${trip.trainNumber} ${trip.date} ${trip.fromTime}→${trip.toTime} (${trip.cause})`;
}

type ArchiveOperation = 'report' | 'backfill-classifications' | 'reconcile-trips';

interface ArchiveCommandOptions {
  readonly fahrplanYear?: string;
  readonly verbose: boolean;
  readonly operation: ArchiveOperation;
}

function parseCommandOptions(args: string[]): ArchiveCommandOptions {
  let fahrplanYear: string | undefined;
  let verbose = false;
  let operation: ArchiveOperation = 'report';
  for (const arg of args) {
    if (arg === '--')
      continue; // tolerate the npm `--` separator if it slips through
    else if (arg.startsWith('--year=')) {
      fahrplanYear = arg.slice('--year='.length).trim();
    } else if (arg === '--verbose') verbose = true;
    else if (arg === '--write') {
      if (operation !== 'report') throw new Error('Use only one write mode.');
      operation = 'backfill-classifications';
    } else if (arg === '--write-trips') {
      if (operation !== 'report') throw new Error('Use only one write mode.');
      operation = 'reconcile-trips';
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return { fahrplanYear, verbose, operation };
}

/** Directory names under `docs/` that are Fahrplan-year buckets, optionally filtered to one. */
async function findFahrplanYearDirectories(
  baseDir: string,
  requestedYear?: string,
): Promise<string[]> {
  const yearDirectories = await listFahrplanYearDirectories(baseDir);
  return requestedYear
    ? yearDirectories.filter((yearDirectory) => yearDirectory === requestedYear)
    : yearDirectories;
}

/** Trip identity within an article report, including the destination line file. */
function getLineScopedTripKey(trip: Cancellation): string {
  return JSON.stringify([trip.line, getCancellationKey(trip)]);
}

/** Loads every stored cancellation for a year, indexed by source URL then by line/trip key. */
async function loadStoredTripsBySourceUrl(
  fahrplanYearDirectory: string,
): Promise<Map<string, Map<string, Cancellation>>> {
  const tripsBySourceUrl = new Map<string, Map<string, Cancellation>>();
  const lineFilenames = (await listFiles(fahrplanYearDirectory)).filter(
    (name) => name.endsWith('.json') && name !== 'index.json',
  );
  for (const filename of lineFilenames) {
    for (const trip of await loadExistingCancellations(join(fahrplanYearDirectory, filename))) {
      let sourceTrips = tripsBySourceUrl.get(trip.sourceUrl);
      if (!sourceTrips) {
        sourceTrips = new Map();
        tripsBySourceUrl.set(trip.sourceUrl, sourceTrips);
      }
      sourceTrips.set(getLineScopedTripKey(trip), trip);
    }
  }
  return tripsBySourceUrl;
}

interface ArchiveProcessingTotals {
  articlesProcessed: number;
  articlesParsed: number;
  articlesWithParseErrors: number;
  articlesWithoutStructuredTrips: number;
  articlesWithoutSourceUrl: number;
  tripsAdded: number;
  tripsRemoved: number;
  classificationsChanged: number;
  articlesWithDifferences: number;
  /** Write mode: stored trips whose cause/causeKeyword was re-stamped. */
  classificationsUpdated: number;
  /** Write mode: line JSON files rewritten. */
  lineFilesWritten: number;
  /** Trip-reconciliation mode: newly restored trips. */
  tripsRestored: number;
  /** Trip-reconciliation mode: stale/corrupted trips removed. */
  staleTripsRemoved: number;
  /** Trip-reconciliation mode: same-key records whose parsed fields were corrected. */
  tripsCorrected: number;
}

function createArchiveProcessingTotals(): ArchiveProcessingTotals {
  return {
    articlesProcessed: 0,
    articlesParsed: 0,
    articlesWithParseErrors: 0,
    articlesWithoutStructuredTrips: 0,
    articlesWithoutSourceUrl: 0,
    tripsAdded: 0,
    tripsRemoved: 0,
    classificationsChanged: 0,
    articlesWithDifferences: 0,
    classificationsUpdated: 0,
    lineFilesWritten: 0,
    tripsRestored: 0,
    staleTripsRemoved: 0,
    tripsCorrected: 0,
  };
}

/** One archived article reparsed with the current parser. */
interface ParsedArchivedArticle {
  readonly sourceUrl: string;
  readonly trips: readonly Cancellation[];
}

/** Trip identity scoped to its source article, safe to use across line files. */
function getSourceScopedTripKey(trip: Cancellation): string {
  return JSON.stringify([trip.sourceUrl, getCancellationKey(trip)]);
}

/**
 * Reparses one archive file into its source URL + trips, updating the parse totals and warning
 * on any skip. Returns `null` when the file is unreadable, carries no `Quelle` URL, or fails to
 * parse — the single place both report and backfill modes turn frozen text back into trips.
 */
async function parseArchivedArticle(
  archiveFilePath: string,
  totals: ArchiveProcessingTotals,
): Promise<ParsedArchivedArticle | null> {
  totals.articlesProcessed += 1;
  const archiveContent = await readTextFile(archiveFilePath);
  if (archiveContent === null) return null;

  const { url: sourceUrl, body: articleBody } = parseArchive(archiveContent);
  if (!sourceUrl) {
    totals.articlesWithoutSourceUrl += 1;
    console.warn(`  ? ${basename(archiveFilePath)}: no Quelle header, cannot map to stored data`);
    return null;
  }

  try {
    const trips = parseDetailPage(articleBody, sourceUrl);
    totals.articlesParsed += 1;
    return { sourceUrl, trips };
  } catch (error) {
    const errorMessage = (error as Error).message;
    const hasNumberedTripRow = articleBody
      .split(/\r?\n/)
      .some((line) => /^\s*\d{4,6}\b/.test(line));
    if (
      error instanceof ParseError &&
      errorMessage.includes('Incorrect parse: no trips were found') &&
      !hasNumberedTripRow
    ) {
      totals.articlesWithoutStructuredTrips += 1;
      console.log(`  - ${basename(archiveFilePath)}: no structured train-number trip rows`);
      return null;
    }
    totals.articlesWithParseErrors += 1;
    const errorType = error instanceof ParseError ? 'ParseError' : 'error';
    console.warn(`  ! ${basename(archiveFilePath)}: ${errorType}: ${errorMessage.split('\n')[0]}`);
    return null;
  }
}

/** Reparses one archive file and reports how it differs from what is stored for its URL. */
async function reportArchivedArticleDifferences(
  filePath: string,
  storedTripsBySourceUrl: Map<string, Map<string, Cancellation>>,
  options: ArchiveCommandOptions,
  totals: ArchiveProcessingTotals,
): Promise<void> {
  const archivedArticle = await parseArchivedArticle(filePath, totals);
  if (!archivedArticle) return;
  const { sourceUrl, trips: reparsedTrips } = archivedArticle;

  const storedTrips = storedTripsBySourceUrl.get(sourceUrl) ?? new Map<string, Cancellation>();
  const reparsedTripsByKey = new Map(
    reparsedTrips.map((trip) => [getLineScopedTripKey(trip), trip]),
  );

  const addedTrips = reparsedTrips.filter((trip) => !storedTrips.has(getLineScopedTripKey(trip)));
  const removedTrips = [...storedTrips.values()].filter(
    (trip) => !reparsedTripsByKey.has(getLineScopedTripKey(trip)),
  );
  const reclassifiedTrips = reparsedTrips.filter((trip) => {
    const storedTrip = storedTrips.get(getLineScopedTripKey(trip));
    return (
      storedTrip &&
      (storedTrip.cause !== trip.cause || storedTrip.causeKeyword !== trip.causeKeyword)
    );
  });

  if (addedTrips.length === 0 && removedTrips.length === 0 && reclassifiedTrips.length === 0) {
    return;
  }

  totals.articlesWithDifferences += 1;
  totals.tripsAdded += addedTrips.length;
  totals.tripsRemoved += removedTrips.length;
  totals.classificationsChanged += reclassifiedTrips.length;

  console.log(
    `  ~ ${basename(filePath)}: +${addedTrips.length} added, -${removedTrips.length} removed, ` +
      `${reclassifiedTrips.length} classification change(s)`,
  );
  if (options.verbose) {
    for (const trip of addedTrips) console.log(`      + ${formatTrip(trip)}`);
    for (const trip of removedTrips) console.log(`      - ${formatTrip(trip)}`);
    for (const trip of reclassifiedTrips) {
      const storedTrip = storedTrips.get(getLineScopedTripKey(trip));
      console.log(
        `      ~ ${formatTrip(trip)} [${trip.causeKeyword ?? 'no keyword'}] ` +
          `(was ${storedTrip?.cause} [${storedTrip?.causeKeyword ?? 'no keyword'}])`,
      );
    }
  }
}

/**
 * Reparses every archive in a year into a lookup of the {@link CauseClassification} it yields,
 * keyed by source URL then trip key. Parse failures are skipped (they can't inform a re-stamp),
 * so backfill never invents or drops trips — it only refines cause.
 */
async function loadReparsedClassificationsBySourceUrl(
  archiveDirectory: string,
  archiveFilenames: readonly string[],
  totals: ArchiveProcessingTotals,
): Promise<Map<string, Map<string, CauseClassification>>> {
  const classificationsBySourceUrl = new Map<string, Map<string, CauseClassification>>();
  for (const filename of archiveFilenames) {
    const archivedArticle = await parseArchivedArticle(join(archiveDirectory, filename), totals);
    if (!archivedArticle) continue;
    const classificationsByTripKey = new Map<string, CauseClassification>();
    for (const trip of archivedArticle.trips) {
      classificationsByTripKey.set(getCancellationKey(trip), {
        cause: trip.cause,
        causeKeyword: trip.causeKeyword,
      });
    }
    classificationsBySourceUrl.set(archivedArticle.sourceUrl, classificationsByTripKey);
  }
  return classificationsBySourceUrl;
}

/**
 * Backfills one year: re-stamps `cause`/`causeKeyword` on every stored trip whose article is
 * archived and reparses to the same trip key. Only these two fields change; trip identity and
 * order are preserved, so an unaffected file stays byte-identical.
 */
async function backfillClassificationsForYear(
  fahrplanYearDirectory: string,
  options: ArchiveCommandOptions,
  totals: ArchiveProcessingTotals,
): Promise<void> {
  const archiveDirectory = join(fahrplanYearDirectory, ARCHIVE_SUBDIR);
  const archiveFilenames = (await listFiles(archiveDirectory))
    .filter((filename) => filename.endsWith('.txt'))
    .sort();
  if (archiveFilenames.length === 0) return;

  const classificationsBySourceUrl = await loadReparsedClassificationsBySourceUrl(
    archiveDirectory,
    archiveFilenames,
    totals,
  );
  const lineFilenames = (await listFiles(fahrplanYearDirectory)).filter(
    (name) => name.endsWith('.json') && name !== 'index.json',
  );

  for (const filename of lineFilenames) {
    const filePath = join(fahrplanYearDirectory, filename);
    const trips = await loadExistingCancellations(filePath);
    let hasClassificationUpdates = false;
    const classificationUpdatedTrips = trips.map((trip) => {
      const classification = classificationsBySourceUrl
        .get(trip.sourceUrl)
        ?.get(getCancellationKey(trip));
      if (
        !classification ||
        (classification.cause === trip.cause && classification.causeKeyword === trip.causeKeyword)
      ) {
        return trip;
      }
      hasClassificationUpdates = true;
      totals.classificationsUpdated += 1;
      if (options.verbose) {
        console.log(
          `      ~ ${formatTrip(trip)} → ${classification.cause}` +
            `${classification.causeKeyword ? ` [${classification.causeKeyword}]` : ''}`,
        );
      }
      return {
        ...trip,
        cause: classification.cause,
        causeKeyword: classification.causeKeyword,
      };
    });
    if (hasClassificationUpdates) {
      await writeJsonFile(filePath, classificationUpdatedTrips);
      totals.lineFilesWritten += 1;
      console.log(`  ~ ${filename}: re-stamped classification on affected trip(s)`);
    }
  }
}

/**
 * Reconciles stored trips for successfully parsed archives. A parse failure is deliberately
 * absent from `reparsedTripsBySourceUrl`, so it can never delete that article's existing data.
 */
async function reconcileTripsForYear(
  fahrplanYearDirectory: string,
  options: ArchiveCommandOptions,
  totals: ArchiveProcessingTotals,
): Promise<void> {
  const archiveDirectory = join(fahrplanYearDirectory, ARCHIVE_SUBDIR);
  const archiveFilenames = (await listFiles(archiveDirectory))
    .filter((filename) => filename.endsWith('.txt'))
    .sort();
  const reparsedTripsBySourceUrl = new Map<string, readonly Cancellation[]>();
  for (const filename of archiveFilenames) {
    const archivedArticle = await parseArchivedArticle(join(archiveDirectory, filename), totals);
    if (archivedArticle) {
      reparsedTripsBySourceUrl.set(archivedArticle.sourceUrl, archivedArticle.trips);
    }
  }

  const lineFilenames = (await listFiles(fahrplanYearDirectory)).filter(
    (name) => name.endsWith('.json') && name !== 'index.json',
  );
  const storedTripsByLine = new Map<string, Cancellation[]>();
  const storedTripsBySourceKey = new Map<string, Cancellation>();
  for (const filename of lineFilenames) {
    const line = filename.slice(0, -'.json'.length);
    const trips = await loadExistingCancellations(join(fahrplanYearDirectory, filename));
    storedTripsByLine.set(line, trips);
    for (const trip of trips) {
      storedTripsBySourceKey.set(getSourceScopedTripKey(trip), trip);
    }
  }

  const reconciledTripsByLine = new Map<string, Cancellation[]>();
  for (const [line, trips] of storedTripsByLine) {
    reconciledTripsByLine.set(
      line,
      trips.filter((trip) => !reparsedTripsBySourceUrl.has(trip.sourceUrl)),
    );
  }

  for (const trips of reparsedTripsBySourceUrl.values()) {
    for (const trip of trips) {
      const storedTrip = storedTripsBySourceKey.get(getSourceScopedTripKey(trip));
      const reconciledTrip = storedTrip ? { ...trip, capturedAt: storedTrip.capturedAt } : trip;
      const lineTrips = reconciledTripsByLine.get(trip.line) ?? [];
      lineTrips.push(reconciledTrip);
      reconciledTripsByLine.set(trip.line, lineTrips);
    }
  }

  for (const [line, unsortedReconciledTrips] of reconciledTripsByLine) {
    const storedTrips = storedTripsByLine.get(line) ?? [];
    const reconciledTrips = [...unsortedReconciledTrips].sort(compareCancellationsBySchedule);
    const storedTripsByKey = new Map(
      storedTrips.map((trip) => [getSourceScopedTripKey(trip), trip]),
    );
    const reconciledTripKeys = new Set(reconciledTrips.map(getSourceScopedTripKey));
    const restoredTrips = reconciledTrips.filter(
      (trip) => !storedTripsByKey.has(getSourceScopedTripKey(trip)),
    );
    const removedTrips = storedTrips.filter(
      (trip) => !reconciledTripKeys.has(getSourceScopedTripKey(trip)),
    );
    const correctedTrips = reconciledTrips.filter((trip) => {
      const storedTrip = storedTripsByKey.get(getSourceScopedTripKey(trip));
      return storedTrip !== undefined && !isDeepStrictEqual(storedTrip, trip);
    });
    if (restoredTrips.length === 0 && removedTrips.length === 0 && correctedTrips.length === 0) {
      continue;
    }

    await writeJsonFile(join(fahrplanYearDirectory, `${line}.json`), reconciledTrips);
    totals.lineFilesWritten += 1;
    totals.tripsRestored += restoredTrips.length;
    totals.staleTripsRemoved += removedTrips.length;
    totals.tripsCorrected += correctedTrips.length;
    console.log(
      `  ~ ${line}.json: +${restoredTrips.length} restored, ` +
        `~${correctedTrips.length} corrected, -${removedTrips.length} removed`,
    );
    if (options.verbose) {
      for (const trip of restoredTrips) console.log(`      + ${formatTrip(trip)}`);
      for (const trip of correctedTrips) console.log(`      ~ ${formatTrip(trip)}`);
      for (const trip of removedTrips) console.log(`      - ${formatTrip(trip)}`);
    }
  }
}

async function main(): Promise<void> {
  const options = parseCommandOptions(process.argv.slice(2));
  const fahrplanYearDirectories = await findFahrplanYearDirectories(DATA_DIR, options.fahrplanYear);
  if (fahrplanYearDirectories.length === 0) {
    console.log(`No Fahrplan-year archives found under ${DATA_DIR}.`);
    return;
  }

  const totals = createArchiveProcessingTotals();
  for (const fahrplanYear of fahrplanYearDirectories) {
    const fahrplanYearDirectory = join(DATA_DIR, fahrplanYear);
    const archiveDirectory = join(fahrplanYearDirectory, ARCHIVE_SUBDIR);
    const archiveFilenames = (await listFiles(archiveDirectory)).filter((filename) =>
      filename.endsWith('.txt'),
    );
    if (archiveFilenames.length === 0) continue;

    console.log(`\n${fahrplanYear} (${archiveFilenames.length} archived article(s)):`);
    switch (options.operation) {
      case 'backfill-classifications':
        await backfillClassificationsForYear(fahrplanYearDirectory, options, totals);
        continue;
      case 'reconcile-trips':
        await reconcileTripsForYear(fahrplanYearDirectory, options, totals);
        continue;
      case 'report': {
        const storedTripsBySourceUrl = await loadStoredTripsBySourceUrl(fahrplanYearDirectory);
        for (const filename of archiveFilenames.sort()) {
          await reportArchivedArticleDifferences(
            join(archiveDirectory, filename),
            storedTripsBySourceUrl,
            options,
            totals,
          );
        }
        continue;
      }
    }
  }

  const parseSummary =
    `\nSummary: ${totals.articlesProcessed} archived article(s) — ` +
    `${totals.articlesParsed} parsed, ` +
    `${totals.articlesWithoutStructuredTrips} without structured trip rows, ` +
    `${totals.articlesWithParseErrors} parse error(s), ` +
    `${totals.articlesWithoutSourceUrl} without a URL.\n`;

  switch (options.operation) {
    case 'backfill-classifications':
      console.log(
        parseSummary +
          `Backfill: re-stamped ${totals.classificationsUpdated} trip(s) across ` +
          `${totals.lineFilesWritten} file(s).`,
      );
      return;
    case 'reconcile-trips':
      console.log(
        parseSummary +
          `Reconciled trips: +${totals.tripsRestored} restored, ` +
          `~${totals.tripsCorrected} corrected, -${totals.staleTripsRemoved} removed across ` +
          `${totals.lineFilesWritten} file(s).`,
      );
      return;
    case 'report':
      console.log(
        parseSummary +
          `Diffs vs stored: ${totals.articlesWithDifferences} article(s) — ` +
          `+${totals.tripsAdded} would-add, -${totals.tripsRemoved} would-remove, ` +
          `${totals.classificationsChanged} classification change(s).`,
      );
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
