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
 *
 * Exit code is 0 regardless of findings. Pipe/read the summary to act on it.
 */

import { basename, join } from 'node:path';
import { DATA_DIR } from '../src/config.js';
import { getCancellationKey, loadExistingCancellations } from '../src/storage.js';
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

interface Options {
  readonly year?: string;
  readonly verbose: boolean;
  readonly write: boolean;
}

function parseArgs(argv: string[]): Options {
  let year: string | undefined;
  let verbose = false;
  let write = false;
  for (const arg of argv) {
    if (arg === '--')
      continue; // tolerate the npm `--` separator if it slips through
    else if (arg.startsWith('--year=')) year = arg.slice('--year='.length).trim();
    else if (arg === '--verbose') verbose = true;
    else if (arg === '--write') write = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return { year, verbose, write };
}

/** Directory names under `docs/` that are Fahrplan-year buckets, optionally filtered to one. */
async function findYearDirs(baseDir: string, only?: string): Promise<string[]> {
  const dirs = await listFahrplanYearDirectories(baseDir);
  return only ? dirs.filter((name) => name === only) : dirs;
}

/** Loads every stored cancellation for a year, indexed by source URL then by trip key. */
async function loadStoredByUrl(yearDir: string): Promise<Map<string, Map<string, Cancellation>>> {
  const byUrl = new Map<string, Map<string, Cancellation>>();
  const files = (await listFiles(yearDir)).filter(
    (name) => name.endsWith('.json') && name !== 'index.json',
  );
  for (const file of files) {
    for (const trip of await loadExistingCancellations(join(yearDir, file))) {
      let trips = byUrl.get(trip.sourceUrl);
      if (!trips) {
        trips = new Map();
        byUrl.set(trip.sourceUrl, trips);
      }
      trips.set(getCancellationKey(trip), trip);
    }
  }
  return byUrl;
}

interface Totals {
  articles: number;
  parsedOk: number;
  parseErrors: number;
  noUrl: number;
  added: number;
  removed: number;
  causeChanged: number;
  articlesWithDiffs: number;
  /** Write mode: stored trips whose cause/causeKeyword was re-stamped. */
  restamped: number;
  /** Write mode: line JSON files rewritten. */
  filesWritten: number;
}

function newTotals(): Totals {
  return {
    articles: 0,
    parsedOk: 0,
    parseErrors: 0,
    noUrl: 0,
    added: 0,
    removed: 0,
    causeChanged: 0,
    articlesWithDiffs: 0,
    restamped: 0,
    filesWritten: 0,
  };
}

/** One archived article reparsed with the current parser. */
interface ReparsedArchive {
  readonly url: string;
  readonly trips: readonly Cancellation[];
}

/**
 * Reparses one archive file into its source URL + trips, updating the parse totals and warning
 * on any skip. Returns `null` when the file is unreadable, carries no `Quelle` URL, or fails to
 * parse — the single place both report and backfill modes turn frozen text back into trips.
 */
async function reparseArchiveFile(
  filePath: string,
  totals: Totals,
): Promise<ReparsedArchive | null> {
  totals.articles += 1;
  const content = await readTextFile(filePath);
  if (content === null) return null;

  const { url, body } = parseArchive(content);
  if (!url) {
    totals.noUrl += 1;
    console.warn(`  ? ${basename(filePath)}: no Quelle header, cannot map to stored data`);
    return null;
  }

  try {
    const trips = parseDetailPage(body, url);
    totals.parsedOk += 1;
    return { url, trips };
  } catch (error) {
    totals.parseErrors += 1;
    const kind = error instanceof ParseError ? 'ParseError' : 'error';
    console.warn(`  ! ${basename(filePath)}: ${kind}: ${(error as Error).message.split('\n')[0]}`);
    return null;
  }
}

/** Reparses one archive file and reports how it differs from what is stored for its URL. */
async function reportArticle(
  filePath: string,
  storedByUrl: Map<string, Map<string, Cancellation>>,
  options: Options,
  totals: Totals,
): Promise<void> {
  const parsed = await reparseArchiveFile(filePath, totals);
  if (!parsed) return;
  const { url, trips: reparsed } = parsed;

  const stored = storedByUrl.get(url) ?? new Map<string, Cancellation>();
  const reparsedKeys = new Map(reparsed.map((t) => [getCancellationKey(t), t]));

  const added = reparsed.filter((t) => !stored.has(getCancellationKey(t)));
  const removed = [...stored.values()].filter((t) => !reparsedKeys.has(getCancellationKey(t)));
  const causeChanged = reparsed.filter((t) => {
    const prev = stored.get(getCancellationKey(t));
    return prev && prev.cause !== t.cause;
  });

  if (added.length === 0 && removed.length === 0 && causeChanged.length === 0) return;

  totals.articlesWithDiffs += 1;
  totals.added += added.length;
  totals.removed += removed.length;
  totals.causeChanged += causeChanged.length;

  console.log(
    `  ~ ${basename(filePath)}: +${added.length} added, -${removed.length} removed, ` +
      `${causeChanged.length} cause change(s)`,
  );
  if (options.verbose) {
    for (const t of added) console.log(`      + ${formatTrip(t)}`);
    for (const t of removed) console.log(`      - ${formatTrip(t)}`);
    for (const t of causeChanged) {
      console.log(`      ~ ${formatTrip(t)} (was ${stored.get(getCancellationKey(t))?.cause})`);
    }
  }
}

/**
 * Reparses every archive in a year into a lookup of the {@link CauseClassification} it yields,
 * keyed by source URL then trip key. Parse failures are skipped (they can't inform a re-stamp),
 * so backfill never invents or drops trips — it only refines cause.
 */
async function reparseClassificationsByUrl(
  archiveDir: string,
  files: readonly string[],
  totals: Totals,
): Promise<Map<string, Map<string, CauseClassification>>> {
  const byUrl = new Map<string, Map<string, CauseClassification>>();
  for (const file of files) {
    const parsed = await reparseArchiveFile(join(archiveDir, file), totals);
    if (!parsed) continue;
    const perTrip = new Map<string, CauseClassification>();
    for (const t of parsed.trips) {
      perTrip.set(getCancellationKey(t), { cause: t.cause, causeKeyword: t.causeKeyword });
    }
    byUrl.set(parsed.url, perTrip);
  }
  return byUrl;
}

/**
 * Backfills one year: re-stamps `cause`/`causeKeyword` on every stored trip whose article is
 * archived and reparses to the same trip key. Only these two fields change; trip identity and
 * order are preserved, so an unaffected file stays byte-identical.
 */
async function backfillYear(yearDir: string, options: Options, totals: Totals): Promise<void> {
  const archiveDir = join(yearDir, ARCHIVE_SUBDIR);
  const files = (await listFiles(archiveDir)).filter((f) => f.endsWith('.txt')).sort();
  if (files.length === 0) return;

  const reclassifiedByUrl = await reparseClassificationsByUrl(archiveDir, files, totals);
  const lineFiles = (await listFiles(yearDir)).filter(
    (name) => name.endsWith('.json') && name !== 'index.json',
  );

  for (const file of lineFiles) {
    const filePath = join(yearDir, file);
    const trips = await loadExistingCancellations(filePath);
    let changed = false;
    const next = trips.map((trip) => {
      const reclassified = reclassifiedByUrl.get(trip.sourceUrl)?.get(getCancellationKey(trip));
      if (
        !reclassified ||
        (reclassified.cause === trip.cause && reclassified.causeKeyword === trip.causeKeyword)
      ) {
        return trip;
      }
      changed = true;
      totals.restamped += 1;
      if (options.verbose) {
        console.log(
          `      ~ ${formatTrip(trip)} → ${reclassified.cause}` +
            `${reclassified.causeKeyword ? ` [${reclassified.causeKeyword}]` : ''}`,
        );
      }
      return { ...trip, cause: reclassified.cause, causeKeyword: reclassified.causeKeyword };
    });
    if (changed) {
      await writeJsonFile(filePath, next);
      totals.filesWritten += 1;
      console.log(`  ~ ${file}: re-stamped cause on affected trip(s)`);
    }
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const years = await findYearDirs(DATA_DIR, options.year);
  if (years.length === 0) {
    console.log(`No Fahrplan-year archives found under ${DATA_DIR}.`);
    return;
  }

  const totals = newTotals();
  for (const year of years) {
    const yearDir = join(DATA_DIR, year);
    const archiveDir = join(yearDir, ARCHIVE_SUBDIR);
    const files = (await listFiles(archiveDir)).filter((f) => f.endsWith('.txt'));
    if (files.length === 0) continue;

    console.log(`\n${year} (${files.length} archived article(s)):`);
    if (options.write) {
      await backfillYear(yearDir, options, totals);
      continue;
    }
    const storedByUrl = await loadStoredByUrl(yearDir);
    for (const file of files.sort()) {
      await reportArticle(join(archiveDir, file), storedByUrl, options, totals);
    }
  }

  const parseSummary =
    `\nSummary: ${totals.articles} archived article(s) — ${totals.parsedOk} parsed, ` +
    `${totals.parseErrors} parse error(s), ${totals.noUrl} without a URL.\n`;

  if (options.write) {
    console.log(
      parseSummary +
        `Backfill: re-stamped ${totals.restamped} trip(s) across ${totals.filesWritten} file(s).`,
    );
    return;
  }

  console.log(
    parseSummary +
      `Diffs vs stored: ${totals.articlesWithDiffs} article(s) — +${totals.added} would-add, ` +
      `-${totals.removed} would-remove, ${totals.causeChanged} cause change(s).`,
  );
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
