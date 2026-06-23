/**
 * Signature sidecar for train numbers that GTFS reuses across several S-lines.
 *
 * The flat per-line lists (`<line>.json`) cannot, on their own, tell which of a number's
 * lines a given cancellation belongs to — ~10% of numbers run on more than one line.
 * Those split two ways (see the analysis in the PR description):
 *   - through-running: one physical train that changes line designation mid-run
 *     (e.g. 85411 runs S7 Baden-Baden→Karlsruhe, continues as S4 →Heilbronn). A
 *     cancellation legitimately belongs to BOTH lines.
 *   - recycled: genuinely separate trains that happen to share a Zugnummer the same day
 *     (e.g. 85055 as an S53 Wörth→Karlsruhe AND a separate S6 Pforzheim→Bad Wildbad).
 *     A cancellation belongs to exactly ONE of them.
 *
 * This sidecar records, for each shared number, every GTFS trip's `{ line, dep, arr }`
 * plus the dates it runs. {@link resolveAmbiguousTrip} matches the article's date and the
 * trip's departure/arrival times against these signatures to report exactly the line(s)
 * of the one physical run — collapsing recycled over-reporting while preserving
 * through-running. Generated offline by `scripts/seed-train-lines-from-gtfs.ts`.
 */

import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { getCurrentFahrplanYear } from '../fahrplan.js';
import { normalizeLineUppercase, normalizeTrainNumber } from '../utils/normalization.js';

/** Inclusive `[startYYYYMMDD, endYYYYMMDD]` date range a signature is active for. */
export type DateRange = readonly [string, string];

/** One GTFS trip's timing signature for a shared train number. */
export interface TripSignature {
  /** Normalized (uppercase) line this trip belongs to. */
  readonly line: string;
  /** Scheduled departure time of the first stop, `HH:MM` (GTFS 24h+ folded mod 24). */
  readonly dep: string;
  /** Scheduled arrival time of the last stop, `HH:MM`. */
  readonly arr: string;
  /** Service dates this trip runs on, as compressed inclusive ranges. */
  readonly dates: readonly DateRange[];
}

/** On-disk sidecar shape: `docs/<year>/train-line-definitions/ambiguous-trips.json`. */
export interface AmbiguousTripsFile {
  readonly version: 1;
  readonly year: number;
  /** train number → its trip signatures (only numbers that run on >1 line appear). */
  readonly trips: Readonly<Record<string, readonly TripSignature[]>>;
}

export const AMBIGUOUS_TRIPS_FILENAME = 'ambiguous-trips.json';

/** Outcome of resolving an ambiguous number against its signatures. */
export interface AmbiguousResolution {
  /** The line(s) to report the trip under. */
  readonly lines: string[];
  /**
   * Whether the signatures determined this on their own — true when the article date
   * left a single line, or its departure/arrival times anchored a specific run. When
   * false, `lines` is the full date-active candidate set and the caller should stay
   * conservative (intersect with the article's mentioned lines).
   */
  readonly confident: boolean;
}

/**
 * Tolerance, in minutes, when matching an article's reported time against a GTFS scheduled
 * time. Articles are human-written and round/drift by a minute (e.g. GTFS arrival 14:52
 * reported as 14:53), so exact equality would needlessly reject real matches. Kept tight so
 * it cannot bridge two distinct runs.
 */
const TIME_TOLERANCE_MIN = 2;

/** Minutes in a day, used to unfold midnight-crossing times onto a linear axis. */
const DAY_MIN = 24 * 60;

/** `'HH:MM'` → minutes since midnight, or `null` if it is not a valid clock time. */
function toMinutes(time: string | undefined): number | null {
  if (!time) return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Whether two minute-of-day values are equal within {@link TIME_TOLERANCE_MIN}. */
function near(a: number, b: number): boolean {
  return Math.abs(a - b) <= TIME_TOLERANCE_MIN;
}

/** Distinct lines across any items carrying a `line`, preserving first-seen order. */
function distinctLines(items: readonly { readonly line: string }[]): string[] {
  return [...new Set(items.map((item) => item.line))];
}

/** A cancellation's reported `[from, to]` window, unfolded onto a linear minute axis. */
interface TimeWindow {
  /** Window start, minutes since midnight (the evening side when it crosses midnight). */
  readonly from: number;
  /** Window end; laid out past {@link DAY_MIN} when the window runs into the next day. */
  readonly to: number;
  /** True when `toTime` is past 24:00 (the raw `to` folded below `from`). */
  readonly crossesMidnight: boolean;
}

/**
 * A signature's run projected onto a {@link TimeWindow}'s axis. Keeps the signature's
 * `dep`/`arr` vocabulary, but as linear minutes (a possibly-`>= DAY_MIN` arrival) rather
 * than folded `HH:MM`.
 */
interface LinearRun {
  readonly line: string;
  readonly dep: number;
  readonly arr: number;
}

/** Builds the linear {@link TimeWindow} for an article's times, or `null` if unparseable. */
function toTimeWindow(fromTime: string | undefined, toTime: string | undefined): TimeWindow | null {
  const from = toMinutes(fromTime);
  const to = toMinutes(toTime);
  if (from === null || to === null) return null;
  const crossesMidnight = to < from;
  return { from, to: crossesMidnight ? to + DAY_MIN : to, crossesMidnight };
}

/**
 * Projects each signature's `[dep, arr]` onto the window's axis as a forward interval.
 *
 * Two foldings are undone: a run that crosses midnight internally (`arr < dep`) gains a day
 * on its arrival; and, when the *window* crosses midnight, a run departing in the early
 * morning tail is next day's run, shifted forward a day to sit beside the window rather than
 * ~24h before it. Signatures with unparseable times are dropped.
 */
function projectRuns(signatures: readonly TripSignature[], window: TimeWindow): LinearRun[] {
  const morningCutoff = window.to - DAY_MIN; // raw folded `to`; only meaningful when crossing
  const runs: LinearRun[] = [];
  for (const signature of signatures) {
    let dep = toMinutes(signature.dep);
    let arr = toMinutes(signature.arr);
    if (dep === null || arr === null) continue;
    if (arr < dep) arr += DAY_MIN;
    if (window.crossesMidnight && dep <= morningCutoff) {
      dep += DAY_MIN;
      arr += DAY_MIN;
    }
    runs.push({ line: signature.line, dep, arr });
  }
  return runs;
}

/**
 * Matches projected runs against the window, returning a confident resolution or `null`
 * when the times anchor nothing (the caller then stays conservative).
 *
 *  - Whole-run(s): the window's edges align with a real departure and arrival, so it cancels
 *    every run that falls inside it — one line for a recycled run, several for a through-run.
 *  - Partial segment: otherwise, if the window lies inside exactly one line's run, it is a
 *    sub-segment of that single run. (A window inside several overlapping/sibling runs stays
 *    ambiguous.)
 */
function matchWindow(runs: readonly LinearRun[], window: TimeWindow): AmbiguousResolution | null {
  const startsRun = runs.some((r) => near(r.dep, window.from));
  const endsRun = runs.some((r) => near(r.arr, window.to));
  if (startsRun && endsRun) {
    const within = runs.filter(
      (r) => r.dep >= window.from - TIME_TOLERANCE_MIN && r.arr <= window.to + TIME_TOLERANCE_MIN,
    );
    if (within.length > 0) return { lines: distinctLines(within), confident: true };
  }

  const containing = runs.filter(
    (r) => r.dep <= window.from + TIME_TOLERANCE_MIN && r.arr >= window.to - TIME_TOLERANCE_MIN,
  );
  const containingLines = distinctLines(containing);
  if (containingLines.length === 1) return { lines: containingLines, confident: true };

  return null;
}

/** Article ISO date `YYYY-MM-DD` → GTFS `YYYYMMDD`, or `null` if unparseable. */
export function isoToGtfsDate(isoDate: string | undefined): string | null {
  if (!isoDate) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate.trim());
  return match ? `${match[1]}${match[2]}${match[3]}` : null;
}

/** Whether `gtfsDate` (YYYYMMDD) falls within any of the signature's date ranges. */
function isActiveOn(signature: TripSignature, gtfsDate: string): boolean {
  return signature.dates.some(([start, end]) => gtfsDate >= start && gtfsDate <= end);
}

/**
 * Resolves which line(s) a cancellation belongs to for a number with trip signatures, by
 * narrowing on the article's date and then matching its time window against the runs:
 *
 * 1. Filter to the signatures in service on the date (see the body for the edge cases).
 * 2. If one line remains → confident.
 * 3. Otherwise let {@link matchWindow} anchor the time window to a run; failing that, return
 *    all active lines unconfidently so the caller can constrain to the mentioned lines.
 *
 * Time matching is midnight-aware ({@link toTimeWindow}/{@link projectRuns}) and tolerant of
 * the minute of rounding between human-written article times and GTFS schedule times
 * ({@link TIME_TOLERANCE_MIN}).
 */
export function resolveAmbiguousTrip(
  signatures: readonly TripSignature[],
  trip: { readonly fromTime?: string; readonly toTime?: string; readonly date?: string },
): AmbiguousResolution {
  // 1. Narrow to the signatures in service on the article's date. A known date with no
  //    active signature means the number is not running then (different Fahrplan year or a
  //    feed gap): stay unconfident rather than merge non-coexisting periods. An unparseable
  //    date keeps all signatures and leans on the times below.
  const gtfsDate = isoToGtfsDate(trip.date);
  const active = gtfsDate === null ? signatures : signatures.filter((s) => isActiveOn(s, gtfsDate));
  if (active.length === 0) {
    return { lines: distinctLines(signatures), confident: false };
  }

  // 2. One line on this date → done.
  const activeLines = distinctLines(active);
  if (activeLines.length <= 1) {
    return { lines: activeLines, confident: true };
  }

  // 3. Otherwise disambiguate by matching the article's time window against the runs.
  const window = toTimeWindow(trip.fromTime, trip.toTime);
  if (window !== null) {
    const matched = matchWindow(projectRuns(active, window), window);
    if (matched !== null) return matched;
  }

  return { lines: activeLines, confident: false };
}

function sidecarPath(year: number): string {
  return join(
    process.cwd(),
    'docs',
    String(year),
    'train-line-definitions',
    AMBIGUOUS_TRIPS_FILENAME,
  );
}

/**
 * Loads and normalizes the sidecar for a Fahrplan year. Missing file → empty index
 * (the system degrades to flat-list behavior). Keys and line names are normalized so
 * lookups need not re-normalize.
 */
export function loadAmbiguousTrips(
  fahrplanYear?: number,
): Readonly<Record<string, readonly TripSignature[]>> {
  const year = fahrplanYear ?? getCurrentFahrplanYear();
  if (!year) return {};

  let parsed: AmbiguousTripsFile;
  try {
    parsed = JSON.parse(readFileSync(sidecarPath(year), 'utf-8')) as AmbiguousTripsFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }

  const index: Record<string, TripSignature[]> = {};
  for (const [rawNumber, signatures] of Object.entries(parsed.trips ?? {})) {
    const number = normalizeTrainNumber(rawNumber);
    if (!number) continue;
    const normalized = signatures
      .map((s) => ({ ...s, line: normalizeLineUppercase(s.line) ?? '' }))
      .filter((s) => s.line);
    if (normalized.length > 0) index[number] = normalized;
  }
  return index;
}
