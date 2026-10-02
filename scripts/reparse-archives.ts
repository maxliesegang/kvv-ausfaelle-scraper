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
 *   npm run reparse-archives -- --write-dates # correct stored trip dates from parsed archives
 *
 * Exit code is 0 regardless of findings. Pipe/read the summary to act on it.
 */

import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { DATA_DIR } from '../src/config.js';
import {
  compareCancellationsBySchedule,
  getCancellationKey,
  hasDeparted,
  loadExistingCancellations,
} from '../src/storage.js';
import {
  findUnmappedTrainNumbersError,
  NoTripsFoundError,
  parseDetailPage,
  ParseError,
} from '../src/parser/index.js';
import { toArticleText } from '../src/parser/article-corrections.js';
import { findUnparsedTripLikeRows, leadingTrainNumber } from '../src/parser/trip-parsing.js';
import { ARCHIVE_SUBDIR, parseArchive } from '../src/article-archive.js';
import { getFahrplanYear, listFahrplanYearDirectories } from '../src/fahrplan.js';
import { listFiles, readTextFile, writeJsonFile } from '../src/utils/fs.js';
import { extractDetailId } from '../src/utils/normalization.js';
import { namesSameStop } from '../src/verification/verify.js';
import type { CauseClassification } from '../src/cause.js';
import type { Cancellation } from '../src/types.js';

/** One-line, human-readable identity of a trip for the diff report. */
function formatTrip(trip: Cancellation): string {
  return `${trip.line} ${trip.trainNumber} ${trip.date} ${trip.fromTime}→${trip.toTime} (${trip.cause})`;
}

type ArchiveOperation = 'report' | 'backfill-classifications' | 'reconcile-trips' | 'redate-trips';

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
    } else if (arg === '--write-dates') {
      if (operation !== 'report') throw new Error('Use only one write mode.');
      operation = 'redate-trips';
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
    ? yearDirectories.filter((directory) => directory === requestedYear)
    : yearDirectories;
}

/**
 * Physical-trip identity, ignoring which notice reported it — the key the live store
 * deduplicates by, widened with the line so it stays unique across line files.
 *
 * `line` defaults to the trip's own, and is passed explicitly only for a stored trip, which is
 * keyed by the file it lives in exactly as `storage.ts` bucketed it. (The two agree in practice;
 * naming the parameter keeps that assumption visible rather than implied.)
 */
function getLineScopedTripKey(trip: Cancellation, line: string = trip.line): string {
  return JSON.stringify([line, getCancellationKey(trip)]);
}

/** Loads every stored line file of a year, keyed by the line its filename names. */
async function loadStoredTripsByLine(
  fahrplanYearDirectory: string,
): Promise<Map<string, Cancellation[]>> {
  const lineFilenames = (await listFiles(fahrplanYearDirectory)).filter(
    (name) => name.endsWith('.json') && name !== 'index.json',
  );
  const storedTripsByLine = new Map<string, Cancellation[]>();
  for (const filename of lineFilenames) {
    const line = filename.slice(0, -'.json'.length);
    storedTripsByLine.set(
      line,
      await loadExistingCancellations(join(fahrplanYearDirectory, filename)),
    );
  }
  return storedTripsByLine;
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
  /** Report mode: stored trips `--write-trips` would correct, classification changes included. */
  tripsToCorrect: number;
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
  /** Redate mode: stored trips moved to the date their archived article now yields. */
  tripsRedated: number;
  /** Redate mode: records a redate collapsed onto an already-stored trip of the same identity. */
  tripsMergedAfterRedate: number;
  /** Redate mode: redates skipped because the new date lies in another Fahrplan year. */
  tripsSkippedAcrossFahrplanYears: number;
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
    tripsToCorrect: 0,
    articlesWithDifferences: 0,
    classificationsUpdated: 0,
    lineFilesWritten: 0,
    tripsRestored: 0,
    staleTripsRemoved: 0,
    tripsCorrected: 0,
    tripsRedated: 0,
    tripsMergedAfterRedate: 0,
    tripsSkippedAcrossFahrplanYears: 0,
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
 * Whether a trip-less article still lists trip rows the parser could not turn into trips: a
 * numbered row no format matched, or valid rows whose train numbers map to none of the article's
 * lines. Mirrors the checks `processRssItem` raises in a live run, so an article the scraper would
 * fail on is a parse error here too, never "no structured trip rows".
 */
export function listsUnresolvedTripRows(articleBody: string, sourceUrl: string): boolean {
  const hasUnparsedNumberedRow = findUnparsedTripLikeRows(
    toArticleText(articleBody, sourceUrl),
    new Set(),
  ).some((row) => leadingTrainNumber(row) !== undefined);
  return (
    hasUnparsedNumberedRow || findUnmappedTrainNumbersError(articleBody, sourceUrl) !== undefined
  );
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
    if (error instanceof NoTripsFoundError && !listsUnresolvedTripRows(articleBody, sourceUrl)) {
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

/** The fields a correction rewrites, as `field: old → new`; a dropped verdict is named, not dumped. */
function describeFieldChanges(stored: Cancellation, corrected: Cancellation): string {
  const fields = new Set([...Object.keys(stored), ...Object.keys(corrected)]);
  return [...fields]
    .filter((field) => {
      const key = field as keyof Cancellation;
      return !isDeepStrictEqual(stored[key], corrected[key]);
    })
    .map((field) =>
      field === 'verification'
        ? 'verification dropped'
        : `${field}: ${String(stored[field as keyof Cancellation])} → ` +
          `${String(corrected[field as keyof Cancellation])}`,
    )
    .join(', ');
}

/** Whether a correction changes the trip's classification. */
function changesClassification({ stored, reconciled }: TripCorrection): boolean {
  return stored.cause !== reconciled.cause || stored.causeKeyword !== reconciled.causeKeyword;
}

/** Whether a correction changes anything besides the classification. */
function changesTripFields({ stored, reconciled }: TripCorrection): boolean {
  return !isDeepStrictEqual(stored, {
    ...reconciled,
    cause: stored.cause,
    causeKeyword: stored.causeKeyword,
  });
}

/**
 * Reports what `--write-trips` would change, grouped by the article each change is attributed to.
 * It reads the very {@link TripReconciliation} the write mode applies, so the prediction cannot
 * drift from the write: a trip moving to a sibling notice shows as removed from one article and
 * restored under the other, exactly as it is written.
 */
function reportTripReconciliation(
  reconciliation: TripReconciliation,
  options: ArchiveCommandOptions,
  totals: ArchiveProcessingTotals,
): void {
  const changes = [...reconciliation.changesByLine.values()];
  const restoredTrips = changes.flatMap((lineChanges) => lineChanges.restored);
  const removedTrips = changes.flatMap((lineChanges) => lineChanges.removed);
  const corrections = changes.flatMap((lineChanges) => lineChanges.corrected);
  const sourceUrls = [
    ...new Set([
      ...restoredTrips.map((trip) => trip.sourceUrl),
      ...removedTrips.map((trip) => trip.sourceUrl),
      ...corrections.map(({ stored }) => stored.sourceUrl),
    ]),
  ].sort();

  for (const sourceUrl of sourceUrls) {
    const isFromArticle = (trip: Cancellation) => trip.sourceUrl === sourceUrl;
    const articleRestoredTrips = restoredTrips.filter(isFromArticle);
    const articleRemovedTrips = removedTrips.filter(isFromArticle);
    const articleCorrections = corrections.filter(({ stored }) => isFromArticle(stored));
    const fieldCorrections = articleCorrections.filter(changesTripFields);
    const reclassifications = articleCorrections.filter(changesClassification);
    const retainedPastTrips = reconciliation.retainedPastTrips.filter(isFromArticle);

    totals.articlesWithDifferences += 1;
    totals.tripsAdded += articleRestoredTrips.length;
    totals.tripsRemoved += articleRemovedTrips.length;
    totals.tripsToCorrect += articleCorrections.length;
    totals.classificationsChanged += reclassifications.length;

    const retainedNote =
      retainedPastTrips.length > 0 ? `, ${retainedPastTrips.length} past trip(s) retained` : '';
    console.log(
      `  ~ ${extractDetailId(sourceUrl) ?? sourceUrl}: +${articleRestoredTrips.length} added, ` +
        `-${articleRemovedTrips.length} removed, ~${articleCorrections.length} corrected ` +
        `(${reclassifications.length} classification change(s))${retainedNote}`,
    );
    if (!options.verbose) continue;
    for (const trip of articleRestoredTrips) console.log(`      + ${formatTrip(trip)}`);
    for (const trip of articleRemovedTrips) console.log(`      - ${formatTrip(trip)}`);
    for (const trip of retainedPastTrips) console.log(`      = ${formatTrip(trip)} (departed)`);
    for (const { stored, reconciled } of fieldCorrections) {
      console.log(`      ~ ${formatTrip(stored)}: ${describeFieldChanges(stored, reconciled)}`);
    }
    for (const { stored, reconciled } of reclassifications) {
      console.log(
        `      ~ ${formatTrip(reconciled)} [${reconciled.causeKeyword ?? 'no keyword'}] ` +
          `(was ${stored.cause} [${stored.causeKeyword ?? 'no keyword'}])`,
      );
    }
  }
}

/**
 * Reparses every archive in a year, keyed by source URL. A parse failure is deliberately absent,
 * so it can never delete or rewrite that article's stored data.
 */
async function loadReparsedTripsBySourceUrl(
  fahrplanYearDirectory: string,
  totals: ArchiveProcessingTotals,
): Promise<Map<string, readonly Cancellation[]>> {
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
  return reparsedTripsBySourceUrl;
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
 * Whether a stored verdict still describes the trip a reparse produced.
 *
 * `verification` is computed over the announced segment — `fromTime` → `toStop` on a given date —
 * and, unlike the trip itself, it cannot be recomputed at will: bahn.expert answers for a rolling
 * seven days, after which a dropped verdict is gone for good. So it is carried across a
 * correction that leaves those endpoints intact, and dropped only when the reparse moves them,
 * where it would be evidence about a different segment. Dropping it makes `needsCheck` re-ask,
 * which is the right outcome while the trip is still inside the lookback window.
 *
 * Endpoint names are compared as stops, not strings: KVV re-spells a stop between edits of one
 * notice (`Albtalbahnhof` → `KA-Albtalbahnhof`), which leaves the segment where it was.
 */
function describesSameVerifiedSegment(stored: Cancellation, reparsed: Cancellation): boolean {
  return (
    stored.date === reparsed.date &&
    stored.trainNumber === reparsed.trainNumber &&
    namesSameStop(stored.fromStop, reparsed.fromStop) &&
    stored.fromTime === reparsed.fromTime &&
    namesSameStop(stored.toStop, reparsed.toStop) &&
    stored.toTime === reparsed.toTime
  );
}

/**
 * The record a reparsed trip replaces its stored copy with. `capturedAt`, `restoredFrom` and
 * `verification` are provenance the reparse cannot know: the archive says what KVV published, not
 * when we first saw it, that the record was recovered by hand, or what the train actually did. All
 * must survive a correction, or reconciliation silently rewrites history. The verdict is kept only
 * while it still describes the same announced segment (see {@link describesSameVerifiedSegment}).
 */
function applyStoredProvenance(stored: Cancellation, reparsed: Cancellation): Cancellation {
  return {
    ...reparsed,
    capturedAt: stored.capturedAt,
    ...(stored.restoredFrom ? { restoredFrom: stored.restoredFrom } : {}),
    ...(stored.verification && describesSameVerifiedSegment(stored, reparsed)
      ? { verification: stored.verification }
      : {}),
  };
}

/** A stored trip and the record reconciliation replaces it with. */
export interface TripCorrection {
  readonly stored: Cancellation;
  readonly reconciled: Cancellation;
}

/** What reconciliation changes in one line file, matched by source-scoped trip key. */
export interface LineTripChanges {
  /** Reconciled trips with no stored copy under the same source in this line file. */
  readonly restored: readonly Cancellation[];
  /** Same-source records whose content changed (parsed fields, classification or verdict). */
  readonly corrected: readonly TripCorrection[];
  /** Stored trips the reconciled line file no longer holds. */
  readonly removed: readonly Cancellation[];
}

export interface TripReconciliation {
  /** Every stored line plus any new one, holding its reconciled trips in canonical order. */
  readonly tripsByLine: ReadonlyMap<string, readonly Cancellation[]>;
  /** Only the lines that change. */
  readonly changesByLine: ReadonlyMap<string, LineTripChanges>;
  /** Stored trips a reparsed article no longer lists, kept because they already departed. */
  readonly retainedPastTrips: readonly Cancellation[];
}

/**
 * Reconciles a year's stored trips with its successfully reparsed archives — pure, no I/O, so the
 * write mode and the report share one result and the rules below are unit-testable.
 *
 * Only articles present in `reparsedTripsBySourceUrl` are reconciled; a parse failure must be
 * left out by the caller, so it can never delete that article's stored data.
 */
export function reconcileArchivedTrips(
  storedTripsByLine: ReadonlyMap<string, readonly Cancellation[]>,
  reparsedTripsBySourceUrl: ReadonlyMap<string, readonly Cancellation[]>,
  nowMs: number,
): TripReconciliation {
  // A multi-line article stores one copy of a shared trip per line bucket, and all copies share
  // the same source-scoped key. Keep every copy so the lookup below can prefer the one the
  // reparse produced; a single-entry map would silently keep whichever line file was read last.
  const storedTripsBySourceKey = new Map<string, Cancellation[]>();
  for (const trips of storedTripsByLine.values()) {
    for (const trip of trips) {
      const sourceKey = getSourceScopedTripKey(trip);
      const sameKeyTrips = storedTripsBySourceKey.get(sourceKey);
      if (sameKeyTrips) {
        sameKeyTrips.push(trip);
      } else {
        storedTripsBySourceKey.set(sourceKey, [trip]);
      }
    }
  }

  // KVV republishes the same cancellation across successive notices, so two archived articles can
  // reparse to one physical trip under different `sourceUrl`s. The live store keys by trip
  // identity (`mergeTrip`) and therefore holds it once; collecting by source-scoped key alone
  // would keep it once per article and write duplicates this store never had. So the reconciled
  // set is keyed by identity — line plus `getCancellationKey` — and each identity is filled once.
  const reconciledTripsByIdentity = new Map<string, { line: string; trip: Cancellation }>();

  // Stored trips whose article was not reparsed this run: nothing re-read them, so they stand.
  // Departed trips stand too — the archive captured KVV's rolling "still upcoming" list, and
  // dropping a past trip from it is garbage collection, not a retraction. This mirrors
  // `reconcileBucket` in `src/storage.ts`, so the tooling and the live scraper converge on the
  // same stored set instead of undoing each other.
  const departedStoredTrips: Cancellation[] = [];
  for (const [line, trips] of storedTripsByLine) {
    for (const trip of trips) {
      const wasReparsed = reparsedTripsBySourceUrl.has(trip.sourceUrl);
      const departed = hasDeparted(trip, nowMs);
      if (!wasReparsed || departed) {
        reconciledTripsByIdentity.set(getLineScopedTripKey(trip, line), { line, trip });
      }
      if (wasReparsed && departed) departedStoredTrips.push(trip);
    }
  }

  // Reparsed trips. First writer wins — archives are processed in sorted order — except that a
  // trip the store already published under *this* article always displaces an earlier duplicate,
  // so the published `sourceUrl` and `capturedAt` stay put.
  const reparsedSourceKeys = new Set<string>();
  for (const trips of reparsedTripsBySourceUrl.values()) {
    for (const trip of trips) {
      reparsedSourceKeys.add(getSourceScopedTripKey(trip));
      const identity = getLineScopedTripKey(trip);
      // Prefer the stored copy of the same line: its `line`-relative evidence (a `feedLine`
      // naming any other line, per-trip verdict provenance) describes this bucket's copy,
      // not a sibling's. A different-line copy is still accepted when no same-line copy
      // exists, preserving the cross-file recovery the source-scoped lookup exists for.
      const sameSourceKeyTrips = storedTripsBySourceKey.get(getSourceScopedTripKey(trip)) ?? [];
      const storedTrip =
        sameSourceKeyTrips.find((candidate) => candidate.line === trip.line) ??
        sameSourceKeyTrips[0];
      if (storedTrip === undefined && reconciledTripsByIdentity.has(identity)) {
        continue;
      }

      const reconciledTrip = storedTrip ? applyStoredProvenance(storedTrip, trip) : trip;
      reconciledTripsByIdentity.set(identity, { line: trip.line, trip: reconciledTrip });
    }
  }

  // Every stored line starts empty so a line that lost all its trips is still rewritten.
  const unsortedTripsByLine = new Map<string, Cancellation[]>(
    [...storedTripsByLine.keys()].map((line) => [line, []]),
  );
  for (const { line, trip } of reconciledTripsByIdentity.values()) {
    const lineTrips = unsortedTripsByLine.get(line);
    if (lineTrips) {
      lineTrips.push(trip);
    } else {
      unsortedTripsByLine.set(line, [trip]);
    }
  }

  const tripsByLine = new Map<string, readonly Cancellation[]>();
  const changesByLine = new Map<string, LineTripChanges>();
  for (const [line, unsortedTrips] of unsortedTripsByLine) {
    const reconciledTrips = [...unsortedTrips].sort(compareCancellationsBySchedule);
    tripsByLine.set(line, reconciledTrips);

    const storedTrips = storedTripsByLine.get(line) ?? [];
    const storedTripsByKey = new Map(
      storedTrips.map((trip) => [getSourceScopedTripKey(trip), trip]),
    );
    const reconciledTripKeys = new Set(reconciledTrips.map(getSourceScopedTripKey));
    const restored = reconciledTrips.filter(
      (trip) => !storedTripsByKey.has(getSourceScopedTripKey(trip)),
    );
    const removed = storedTrips.filter(
      (trip) => !reconciledTripKeys.has(getSourceScopedTripKey(trip)),
    );
    const corrected = reconciledTrips.flatMap((reconciled) => {
      const stored = storedTripsByKey.get(getSourceScopedTripKey(reconciled));
      return stored !== undefined && !isDeepStrictEqual(stored, reconciled)
        ? [{ stored, reconciled }]
        : [];
    });
    if (restored.length > 0 || removed.length > 0 || corrected.length > 0) {
      changesByLine.set(line, { restored, corrected, removed });
    }
  }

  return {
    tripsByLine,
    changesByLine,
    // Only departed trips the reparse no longer lists are worth reporting as retained.
    retainedPastTrips: departedStoredTrips.filter(
      (trip) => !reparsedSourceKeys.has(getSourceScopedTripKey(trip)),
    ),
  };
}

/** Writes the line files a reconciliation changes. */
async function writeTripReconciliation(
  fahrplanYearDirectory: string,
  reconciliation: TripReconciliation,
  options: ArchiveCommandOptions,
  totals: ArchiveProcessingTotals,
): Promise<void> {
  for (const [line, { restored, corrected, removed }] of reconciliation.changesByLine) {
    await writeJsonFile(
      join(fahrplanYearDirectory, `${line}.json`),
      reconciliation.tripsByLine.get(line) ?? [],
    );
    totals.lineFilesWritten += 1;
    totals.tripsRestored += restored.length;
    totals.staleTripsRemoved += removed.length;
    totals.tripsCorrected += corrected.length;
    console.log(
      `  ~ ${line}.json: +${restored.length} restored, ` +
        `~${corrected.length} corrected, -${removed.length} removed`,
    );
    if (options.verbose) {
      for (const trip of restored) console.log(`      + ${formatTrip(trip)}`);
      for (const { reconciled } of corrected) console.log(`      ~ ${formatTrip(reconciled)}`);
      for (const trip of removed) console.log(`      - ${formatTrip(trip)}`);
    }
  }
}

/**
 * Trip identity that survives a date correction: the line file it lives in, the train number and
 * the departure clock time. Unlike {@link getLineScopedTripKey} it deliberately omits the date —
 * matching a stored trip to its reparsed self is only possible across a changed date.
 */
function getUndatedTripKey(trip: Cancellation, line: string = trip.line): string {
  return JSON.stringify([line, trip.trainNumber, trip.fromTime]);
}

/**
 * Corrects stored trip dates from their archived article.
 *
 * A notice never dates its trips; until `resolveTripDate` existed, every trip was stored on the
 * article's own day, so an after-midnight departure landed a day early — colliding with the
 * previous day's identical departure. This re-stamps `date` (and nothing else) on every stored
 * trip whose archived article now yields a different one, then collapses any record the new date
 * makes identical to one already stored.
 *
 * It is deliberately separate from `--write-trips`: changing `date` changes trip identity, so a
 * reconciliation run sees the old records as departed (hence retained) and the corrected ones as
 * new, and would leave both. Run this first; `--write-trips` afterwards then restores trips that
 * the wrong date had deduplicated away.
 */
async function redateTripsForYear(
  fahrplanYearDirectory: string,
  options: ArchiveCommandOptions,
  totals: ArchiveProcessingTotals,
): Promise<void> {
  const archiveDirectory = join(fahrplanYearDirectory, ARCHIVE_SUBDIR);
  const archiveFilenames = (await listFiles(archiveDirectory))
    .filter((filename) => filename.endsWith('.txt'))
    .sort();

  const datesBySourceUrl = new Map<string, Map<string, string>>();
  for (const filename of archiveFilenames) {
    const archivedArticle = await parseArchivedArticle(join(archiveDirectory, filename), totals);
    if (!archivedArticle) continue;
    const datesByTripKey = new Map<string, string>();
    for (const trip of archivedArticle.trips) {
      datesByTripKey.set(getUndatedTripKey(trip), trip.date);
    }
    datesBySourceUrl.set(archivedArticle.sourceUrl, datesByTripKey);
  }

  const fahrplanYear = Number(basename(fahrplanYearDirectory));
  const lineFilenames = (await listFiles(fahrplanYearDirectory)).filter(
    (name) => name.endsWith('.json') && name !== 'index.json',
  );

  for (const filename of lineFilenames) {
    const line = filename.slice(0, -'.json'.length);
    const filePath = join(fahrplanYearDirectory, filename);
    const storedTrips = await loadExistingCancellations(filePath);
    let redatedCount = 0;

    const redatedTrips = storedTrips.map((trip) => {
      const date = datesBySourceUrl.get(trip.sourceUrl)?.get(getUndatedTripKey(trip, line));
      if (date === undefined || date === trip.date) return trip;

      // A trip that lands in another Fahrplan year belongs in that year's files, which this
      // per-year pass cannot write. Leave it and report it rather than store it under the
      // wrong year.
      if (getFahrplanYear(date) !== fahrplanYear) {
        totals.tripsSkippedAcrossFahrplanYears += 1;
        console.warn(
          `  ! ${filename}: ${formatTrip(trip)} → ${date} crosses into another Fahrplan year, skipped`,
        );
        return trip;
      }

      redatedCount += 1;
      totals.tripsRedated += 1;
      if (options.verbose) console.log(`      ~ ${formatTrip(trip)} → ${date}`);
      return { ...trip, date };
    });

    if (redatedCount === 0) continue;

    // A corrected date can coincide with a trip already stored under it (the same departure
    // reported again by the next morning's notice). Those are one physical trip, so keep the
    // record observed first and drop the other, exactly as the live store's identity dedup would.
    const tripsByKey = new Map<string, Cancellation>();
    let mergedCount = 0;
    for (const trip of redatedTrips) {
      const key = getCancellationKey(trip);
      const storedTrip = tripsByKey.get(key);
      if (storedTrip === undefined) {
        tripsByKey.set(key, trip);
        continue;
      }
      mergedCount += 1;
      if (trip.capturedAt < storedTrip.capturedAt) tripsByKey.set(key, trip);
    }
    totals.tripsMergedAfterRedate += mergedCount;

    await writeJsonFile(filePath, [...tripsByKey.values()].sort(compareCancellationsBySchedule));
    totals.lineFilesWritten += 1;
    console.log(`  ~ ${filename}: ${redatedCount} redated, ${mergedCount} merged as duplicates`);
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
      case 'redate-trips':
        await redateTripsForYear(fahrplanYearDirectory, options, totals);
        continue;
      case 'report':
      case 'reconcile-trips': {
        const reconciliation = reconcileArchivedTrips(
          await loadStoredTripsByLine(fahrplanYearDirectory),
          await loadReparsedTripsBySourceUrl(fahrplanYearDirectory, totals),
          Date.now(),
        );
        if (options.operation === 'report') {
          reportTripReconciliation(reconciliation, options, totals);
        } else {
          await writeTripReconciliation(fahrplanYearDirectory, reconciliation, options, totals);
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
    case 'redate-trips':
      console.log(
        parseSummary +
          `Redated trips: ${totals.tripsRedated} moved to their departure date, ` +
          `${totals.tripsMergedAfterRedate} merged as duplicates, ` +
          `${totals.tripsSkippedAcrossFahrplanYears} skipped across Fahrplan years, across ` +
          `${totals.lineFilesWritten} file(s).`,
      );
      return;
    case 'report':
      console.log(
        parseSummary +
          `Diffs vs stored: ${totals.articlesWithDifferences} article(s) — ` +
          `+${totals.tripsAdded} would-add, -${totals.tripsRemoved} would-remove, ` +
          `~${totals.tripsToCorrect} would-correct ` +
          `(${totals.classificationsChanged} classification change(s)).`,
      );
  }
}

// Run only when executed directly, so tests can import the pure reconciliation.
const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
