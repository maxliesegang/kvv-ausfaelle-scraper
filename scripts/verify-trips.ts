/**
 * Back-verify stored cancellations against external realtime feeds.
 *
 * Reads `docs/<fahrplan-year>/<line>.json`, and for every trip that has already departed and still
 * falls inside at least one provider's lookback window, asks whether the announced segment
 * actually ran. bahn.expert is the history-capable primary; Transitous is consulted only when the
 * primary result is provisional or failed and the trip is still inside Transitous's one-day
 * best-effort window. The verdict is written to the advisory `verification` field and nothing
 * else — trip identity, cause and dates are never touched.
 *
 * Every Fahrplan year directory is scanned, not just the current one. The window is seven days and
 * a Fahrplan year turns over in mid-December, so for a week each year the trips that need checking
 * live in the *previous* year's directory. Selection discards out-of-window trips cheaply, which
 * makes scanning the closed years a rounding error rather than a cost worth optimising away.
 *
 * Read-only by default (same convention as `reparse-archives.ts`); `--write` persists.
 *
 * Usage:
 *   npm run verify-trips -- [--year=N] [--date=YYYY-MM-DD] [--write] [--recheck] [--verbose]
 *
 * Notes:
 * - Best-effort by design. Network and decode failures are counted and reported, never thrown, so
 *   a third-party outage never turns the *data pipeline* red — the scrape still publishes.
 *   A run in which every single lookup failed is the exception: that is not a flaky trip, it is a
 *   broken integration, and it exits non-zero so the workflow step shows it. Silence cost six days
 *   of verification when bahn.expert moved its gateway from `/rpc` to `/api/trpc`.
 * - `partial`, `no-data` and `unresolved` are re-checked on later Berlin calendar days while the
 *   trip stays inside the window; settled verdicts are left alone unless `--recheck` is passed.
 * - Evidence only ratchets up: a re-check that sees *less* than the stored verdict did is
 *   discarded by the selection layer, because the feed thins realtime out as a day recedes.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DATA_DIR } from '../src/config.js';
import { listFahrplanYearDirectories } from '../src/fahrplan.js';
import { generateSiteIndices } from '../src/site-index.js';
import type { Cancellation } from '../src/types.js';
import { listFiles, readJsonFile, writeJsonFile } from '../src/utils/fs.js';
import { bahnExpertProvider } from '../src/verification/bahn-expert-provider.js';
import { verifyWithProviders, type VerificationProvider } from '../src/verification/provider.js';
import { needsCheck, selectAcrossSources } from '../src/verification/selection.js';
import { transitousProvider } from '../src/verification/transitous-provider.js';
import { type TripVerification, type VerificationSource } from '../src/verification/verify.js';

/** Small enough to stay a polite guest on a hobby-run service. */
const CONCURRENCY = 4;
const PROVIDERS: readonly VerificationProvider[] = [bahnExpertProvider, transitousProvider];

interface Options {
  year?: number;
  date?: string;
  write: boolean;
  recheck: boolean;
  verbose: boolean;
}

function parseArguments(argv: readonly string[]): Options {
  const options: Options = { write: false, recheck: false, verbose: false };
  for (const argument of argv) {
    if (argument === '--write') options.write = true;
    else if (argument === '--recheck') options.recheck = true;
    else if (argument === '--verbose') options.verbose = true;
    else if (argument.startsWith('--year=')) options.year = Number(argument.slice(7));
    else if (argument.startsWith('--date=')) options.date = argument.slice(7);
  }
  return options;
}

/**
 * Collapse an error to the shape of the problem, dropping the parts that vary per trip.
 *
 * Failures are reported grouped by this string rather than one line per trip. A count on its own
 * (`10 request failures (skipped)`) reads like flakiness whatever the cause; `10 x journey.find
 * responded 404` names a moved endpoint on sight, which is the whole difference between a log a
 * maintainer can act on and one they scroll past.
 */
function failureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\b\d{8}-[0-9a-f-]+\b/g, '<journeyId>');
}

function describeVerdict(
  trip: Cancellation,
  verdict: TripVerification,
  retainedPrevious: boolean,
): string {
  const segment =
    `${verdict.segmentCancelledStops} cancelled / ${verdict.segmentTrackedStops} tracked ` +
    `of ${verdict.segmentStops} in segment`;
  const journey =
    `${verdict.journeyCancelledStops} cancelled / ` +
    `${verdict.journeyTrackedStops ?? '?'} tracked ` +
    `of ${verdict.journeyStops} in journey`;
  const feedLine = verdict.feedLine ? ` [feed line ${verdict.feedLine}]` : '';
  const unresolvedReason = verdict.unresolvedReason ? ` [${verdict.unresolvedReason}]` : '';
  const checkedSources = Object.keys(verdict.checks ?? {});
  const sourceSummary =
    checkedSources.length > 1
      ? `[${checkedSources.join('+')}; ${verdict.agreement ?? 'single-source'}]`
      : `[${verdict.source}]`;
  // Marked like `storage.ts` logs its retentions, so a rule that keeps data instead of writing it
  // is visible in a run rather than silent.
  const kept = retainedPrevious ? ' = kept (fresh check saw less evidence)' : '';
  return (
    `  ${verdict.status.padEnd(10)} ${sourceSummary} ${trip.line} ${trip.trainNumber} ${trip.date} ` +
    `${trip.fromTime} ${trip.fromStop} -> ${trip.toStop} ` +
    `(${segment}; ${journey})${feedLine}${unresolvedReason}${kept}`
  );
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

interface RunSummary {
  checked: number;
  failed: number;
  changedFiles: number;
  verdictsRetained: number;
  /** How many failures each distinct problem caused, so the log names the cause, not just a count. */
  readonly failuresByReason: Map<string, number>;
  readonly sourceHealth: Map<
    VerificationSource,
    { attempted: number; succeeded: number; failed: number }
  >;
}

/**
 * Whether a run's outcome says the feed itself is unreachable rather than some trips being awkward.
 *
 * Individual lookups fail all the time — a stale candidate, a timeout, a journey the feed has since
 * forgotten — and none of those deserve a red step. A run that *attempted* lookups and had **every
 * one** of them fail is a different animal: no journey the feed could still answer for would come
 * back that way. That is the signature of a moved endpoint, a rejected User-Agent, or an outage,
 * and it is the only outcome here a maintainer has to do something about.
 *
 * Note the guard is on `checked === 0`, not on a ratio. A partial failure still produced verdicts
 * and self-heals on the next run; only total silence cannot.
 */
export function isSourceUnreachable(summary: {
  readonly checked: number;
  readonly failed: number;
}): boolean {
  return summary.failed > 0 && summary.checked === 0;
}

/**
 * Verify one Fahrplan year directory in place. Returns nothing: everything a run reports is
 * accumulated into `summary` and `countByStatus`, so scanning several years reads as one run
 * rather than one report per directory.
 */
async function verifyFahrplanYear(
  fahrplanYearDirectory: string,
  options: Options,
  now: Date,
  summary: RunSummary,
  countByStatus: Map<string, number>,
): Promise<void> {
  const nowMs = now.getTime();
  const files = (await listFiles(fahrplanYearDirectory)).filter(
    (file) => file.endsWith('.json') && !file.startsWith('index'),
  );

  for (const file of files) {
    const filePath = path.join(fahrplanYearDirectory, file);
    const trips = await readJsonFile<Cancellation[]>(filePath);
    if (!trips || trips.length === 0) continue;

    const pending = trips.filter(
      (trip) =>
        (!options.date || trip.date === options.date) &&
        PROVIDERS.some((provider) => provider.canCheck(trip, now)) &&
        needsCheck(trip, options.recheck, nowMs),
    );
    if (pending.length === 0) continue;

    const outcomes = await mapWithConcurrency(pending, CONCURRENCY, (trip) =>
      verifyWithProviders(trip, now, PROVIDERS),
    );

    const verdictByTrip = new Map<Cancellation, TripVerification>();
    const retainedTrips = new Set<Cancellation>();
    outcomes.forEach((outcome, index) => {
      const trip = pending[index];
      if (!trip) return;
      for (const source of outcome.attemptedSources) {
        const health = summary.sourceHealth.get(source) ?? {
          attempted: 0,
          succeeded: 0,
          failed: 0,
        };
        health.attempted += 1;
        if (outcome.verifications.some((verification) => verification.source === source)) {
          health.succeeded += 1;
        } else {
          health.failed += 1;
        }
        summary.sourceHealth.set(source, health);
      }
      for (const failure of outcome.failures) {
        summary.failed += 1;
        if (options.verbose) {
          const { line, trainNumber, date } = trip;
          console.warn(
            `  ! ${failure.source} ${line} ${trainNumber} ${date}: ${String(failure.error)}`,
          );
        }
        const reason = failureReason(failure.error);
        const key = `${failure.source}: ${reason}`;
        summary.failuresByReason.set(key, (summary.failuresByReason.get(key) ?? 0) + 1);
      }
      if (outcome.verifications.length === 0) {
        return;
      }
      const choice = selectAcrossSources(trip.verification, outcome.verifications);
      verdictByTrip.set(trip, choice.verification);
      if (choice.retainedPrevious) retainedTrips.add(trip);
    });
    if (verdictByTrip.size === 0) continue;

    for (const [trip, verdict] of verdictByTrip) {
      summary.checked += 1;
      if (retainedTrips.has(trip)) summary.verdictsRetained += 1;
      countByStatus.set(verdict.status, (countByStatus.get(verdict.status) ?? 0) + 1);
      if (options.verbose) console.log(describeVerdict(trip, verdict, retainedTrips.has(trip)));
    }

    if (options.write) {
      const updated = trips.map((trip) => {
        const verdict = verdictByTrip.get(trip);
        return verdict ? { ...trip, verification: verdict } : trip;
      });
      await writeJsonFile(filePath, updated);
      summary.changedFiles += 1;
    }
  }
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const now = new Date();

  // Directory names are the source of truth for which years exist, so a closed year keeps being
  // checked for as long as its trips remain inside the feed's window. `--year` narrows this to one
  // directory for a manual backfill.
  const yearDirectories = (await listFahrplanYearDirectories(DATA_DIR)).filter(
    (year) => options.year === undefined || year === String(options.year),
  );

  const summary: RunSummary = {
    checked: 0,
    failed: 0,
    changedFiles: 0,
    verdictsRetained: 0,
    failuresByReason: new Map(),
    sourceHealth: new Map(),
  };
  const countByStatus = new Map<string, number>();

  for (const year of yearDirectories) {
    await verifyFahrplanYear(path.join(DATA_DIR, year), options, now, summary, countByStatus);
  }

  const scope =
    yearDirectories.length === 1
      ? `year ${yearDirectories[0]}`
      : `years ${yearDirectories.join(', ')}`;
  console.log(
    `\nVerified ${summary.checked} trip(s) in Fahrplan ${scope}` +
      (options.write
        ? `, updated ${summary.changedFiles} file(s).`
        : ' (dry run, nothing written).'),
  );
  for (const [status, count] of [...countByStatus].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(4)}  ${status}`);
  }
  if (summary.verdictsRetained > 0) {
    console.log(
      `  ${String(summary.verdictsRetained).padStart(4)}  stored verdicts kept ` +
        '(fresh check saw less evidence)',
    );
  }
  if (summary.failed > 0) {
    console.log(`  ${String(summary.failed).padStart(4)}  request failures (skipped)`);
    for (const [reason, count] of [...summary.failuresByReason].sort((a, b) => b[1] - a[1])) {
      console.log(`        ${String(count).padStart(4)} x ${reason}`);
    }
  }

  // The published indices summarise these verdicts, and the scraper generated them *before* this
  // script ran. Without this they would report the previous run's verdicts on every publish.
  if (options.write && summary.changedFiles > 0) {
    await generateSiteIndices(DATA_DIR);
  }

  for (const [source, health] of summary.sourceHealth) {
    if (isSourceUnreachable({ checked: health.succeeded, failed: health.failed })) {
      console.error(
        `::error::Every one of ${health.failed} ${source} lookup(s) failed — treating the source ` +
          'as unreachable rather than persisting missing-data verdicts.',
      );
      process.exitCode = 1;
    }
  }
}

// Best-effort by contract: never fail the pipeline over a third-party feed. `main` sets a non-zero
// exit code for a wholly unreachable source, which the workflow's `continue-on-error` turns into a
// visibly failed step rather than a failed run — publishing is unaffected, the alarm still rings.
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error('Verification aborted:', error);
    process.exitCode = 1;
  });
}
