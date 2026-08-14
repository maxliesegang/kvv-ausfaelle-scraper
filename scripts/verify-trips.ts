/**
 * Back-verify stored cancellations against an external realtime feed.
 *
 * Reads `docs/<fahrplan-year>/<line>.json`, and for every trip that has already departed and still
 * falls inside bahn.expert's ~6-day window, asks whether the announced segment actually ran. The
 * verdict is written to the trip's advisory `verification` field and nothing else — trip identity,
 * cause and dates are never touched.
 *
 * Read-only by default (same convention as `reparse-archives.ts`); `--write` persists.
 *
 * Usage:
 *   npm run verify-trips -- [--year=N] [--date=YYYY-MM-DD] [--write] [--recheck] [--verbose]
 *
 * Notes:
 * - Best-effort by design. Network and decode failures are counted and reported, never thrown, and
 *   the script always exits 0: a third-party outage must not turn the data pipeline red.
 * - `no-data` and `unresolved` are re-checked on later runs while the trip stays inside the
 *   window; settled verdicts are left alone unless `--recheck` is passed.
 * - Evidence only ratchets up: a re-check that sees *less* than the stored verdict did is
 *   discarded (`retainStrongerVerdict`), because the feed thins realtime out as a day recedes.
 */

import path from 'node:path';
import { DATA_DIR } from '../src/config.js';
import { getFahrplanYear } from '../src/fahrplan.js';
import type { Cancellation } from '../src/types.js';
import { getBerlinWallClockMs } from '../src/utils/berlin-time.js';
import { listFiles, readJsonFile, writeJsonFile } from '../src/utils/fs.js';
import {
  fetchJourneyDetails,
  findJourneys,
  type JourneyCandidate,
} from '../src/verification/bahn-expert.js';
import { isVerifiable, needsCheck, retainStrongerVerdict } from '../src/verification/selection.js';
import {
  classifyJourney,
  createUnresolvedVerification,
  type TripVerification,
} from '../src/verification/verify.js';

const REQUEST_TIMEOUT_MS = 20_000;
/** Small enough to stay a polite guest on a hobby-run service. */
const CONCURRENCY = 4;

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

async function verifyOne(cancellation: Cancellation, now: Date): Promise<TripVerification> {
  const journeyNumber = Number(cancellation.trainNumber);
  if (!Number.isFinite(journeyNumber)) return createUnresolvedVerification(now);

  const departureDate = new Date(getBerlinWallClockMs(cancellation.date, '10:00'));
  const candidates = await findJourneys(journeyNumber, departureDate, REQUEST_TIMEOUT_MS);

  // A Zugnummer is reused across operators, so the stored line is the best hint about which
  // candidate is ours — but only a hint. KVV and the feed name the same run differently often
  // enough (`S51` vs `S52`, `S7` vs `S71`, a depot run as `E`) that requiring an exact match
  // discards real answers. Try the exact line first, then the rest; `classifyJourney` still has
  // to find the announced departure on the right date, which is what actually confirms identity.
  const matchesLine = (candidate: JourneyCandidate): boolean =>
    candidate.train?.line === cancellation.line;
  const ordered = [...candidates.filter(matchesLine), ...candidates.filter((c) => !matchesLine(c))];

  for (const candidate of ordered) {
    const details = await fetchJourneyDetails(candidate.journeyId, REQUEST_TIMEOUT_MS);
    if (!details) continue;
    const verdict = classifyJourney(cancellation, details, now);
    if (verdict) return verdict;
  }
  return createUnresolvedVerification(now);
}

type VerifyOutcome =
  { readonly ok: true; readonly verification: TripVerification } | { readonly ok: false };

/**
 * Verification is advisory, so a failed lookup is a skipped trip, never a thrown run. The trip
 * simply keeps whatever verdict it already had and is retried on a later run.
 */
async function verifySafely(
  cancellation: Cancellation,
  now: Date,
  verbose: boolean,
): Promise<VerifyOutcome> {
  try {
    return { ok: true, verification: await verifyOne(cancellation, now) };
  } catch (error) {
    if (verbose) {
      const { line, trainNumber, date } = cancellation;
      console.warn(`  ! ${line} ${trainNumber} ${date}: ${String(error)}`);
    }
    return { ok: false };
  }
}

function describeVerdict(
  trip: Cancellation,
  verdict: TripVerification,
  retainedPrevious: boolean,
): string {
  const segment =
    `${verdict.segmentCancelledStops} cancelled / ${verdict.segmentTrackedStops} tracked ` +
    `of ${verdict.segmentStops} in segment`;
  const journey = `${verdict.journeyCancelledStops}/${verdict.journeyStops} in journey`;
  const feedLine = verdict.feedLine ? ` [feed line ${verdict.feedLine}]` : '';
  // Marked like `storage.ts` logs its retentions, so a rule that keeps data instead of writing it
  // is visible in a run rather than silent.
  const kept = retainedPrevious ? ' = kept (fresh check saw less evidence)' : '';
  return (
    `  ${verdict.status.padEnd(10)} ${trip.line} ${trip.trainNumber} ${trip.date} ` +
    `${trip.fromTime} ${trip.fromStop} -> ${trip.toStop} (${segment}; ${journey})${feedLine}${kept}`
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

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const now = new Date();
  const nowMs = now.getTime();
  const fahrplanYear = options.year ?? getFahrplanYear(now.toISOString().slice(0, 10));
  const fahrplanYearDirectory = path.join(DATA_DIR, String(fahrplanYear));

  const files = (await listFiles(fahrplanYearDirectory)).filter(
    (file) => file.endsWith('.json') && !file.startsWith('index'),
  );

  const summary = { checked: 0, failed: 0, changedFiles: 0, verdictsRetained: 0 };
  const countByStatus = new Map<string, number>();

  for (const file of files) {
    const filePath = path.join(fahrplanYearDirectory, file);
    const trips = await readJsonFile<Cancellation[]>(filePath);
    if (!trips || trips.length === 0) continue;

    const pending = trips.filter(
      (trip) =>
        (!options.date || trip.date === options.date) &&
        isVerifiable(trip, nowMs) &&
        needsCheck(trip, options.recheck),
    );
    if (pending.length === 0) continue;

    const outcomes = await mapWithConcurrency(pending, CONCURRENCY, (trip) =>
      verifySafely(trip, now, options.verbose),
    );

    const verdictByTrip = new Map<Cancellation, TripVerification>();
    const retainedTrips = new Set<Cancellation>();
    outcomes.forEach((outcome, index) => {
      const trip = pending[index];
      if (!trip) return;
      if (!outcome.ok) {
        summary.failed += 1;
        return;
      }
      const choice = retainStrongerVerdict(trip.verification, outcome.verification);
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

  console.log(
    `\nVerified ${summary.checked} trip(s) in Fahrplan year ${fahrplanYear}` +
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
  }
}

// Best-effort by contract: never fail the pipeline over a third-party feed.
main().catch((error) => {
  console.error('Verification aborted:', error);
});
