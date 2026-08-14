/**
 * Turns a bahn.expert journey into a verdict about one stored cancellation.
 *
 * The load-bearing subtlety is **segment scoping**. A KVV notice does not list a trip's endpoints;
 * it lists the *affected segment* of a longer run. `20019 Ittersbach Rathaus (09:21) - Ettlingen
 * Stadt (09:45)` is one leg of a journey that continues to 10:31. Judging the whole journey would
 * call that trip "ran" — the tail was tracked normally — when in fact the announced segment was
 * never served. So every verdict is computed over the stored `fromTime` → `toStop` window only,
 * and the untouched remainder is used as the control that proves the feed had data at all.
 *
 * Absence of realtime is deliberately **not** treated as cancellation on its own: some journeys
 * carry neither cancellation flags nor realtime, and reporting those as cancelled would
 * manufacture confirmations. They resolve to `no-data` instead.
 */

import type { Cancellation } from '../types.js';
import { formatBerlinWallClock } from '../utils/berlin-time.js';
import { normalizeGermanText } from '../utils/normalization.js';
import type { JourneyDetails, JourneyStop, JourneyStopEvent } from './bahn-expert.js';

export type VerificationStatus =
  /** Every stop of the announced segment reported cancelled, or the journey itself is cancelled. */
  | 'cancelled'
  /** The announced segment was only partly cancelled, or only partly tracked. */
  | 'partial'
  /** The whole announced segment was tracked with no cancellation — the trip ran. */
  | 'ran'
  /** The feed knows the journey but holds neither cancellation flags nor realtime for it. */
  | 'no-data'
  /** No journey matching this line, date and departure time could be resolved. */
  | 'unresolved';

/**
 * Realtime feeds a verdict can be derived from.
 *
 * A union rather than a free-form string: adding a second feed is a deliberate, compile-checked
 * change, and every consumer that switches on provenance is forced to handle the new case.
 */
export type VerificationSource = 'bahn.expert';

/** The feed this module classifies. */
export const VERIFICATION_SOURCE: VerificationSource = 'bahn.expert';

export interface TripVerification {
  readonly status: VerificationStatus;
  /**
   * Which realtime feed answered.
   *
   * Constant today, and knowingly so — the field earns its bytes only once a second feed exists.
   * It is stored anyway because it is the one fact about a verdict that cannot be re-derived
   * later: a trip like `84957`, which one feed simply never observed, is permanently unverifiable
   * *by that feed*, and a future answer from a different source must be distinguishable from this
   * one rather than silently replacing it. Recording provenance from the start keeps the published
   * records comparable across the change instead of splitting them into a before and an after.
   *
   * It is **not** a confidence signal and must not be used to rank verdicts: `retainStrongerVerdict`
   * compares observed stops, and comparing counts across feeds that watch different things would
   * need its own rule rather than an implicit preference for whichever source ran last.
   */
  readonly source: VerificationSource;
  /**
   * Berlin-local date of the check (`2026-08-14`), so a stale verdict is recognisable.
   *
   * Deliberately a date and not a timestamp: everything this field guards is measured in days —
   * the feed's ~6-day window, and the realtime decay `retainStrongerVerdict` exists to resist. A
   * per-run millisecond stamp only adds bytes to every record and churn to every diff.
   */
  readonly checkedAt: string;

  /** Stops in the announced segment — the denominator for the two counts below. */
  readonly segmentStops: number;
  /** Stops in the announced segment the source reported as cancelled. */
  readonly segmentCancelledStops: number;
  /** Stops in the announced segment that carried realtime (i.e. the vehicle was observed). */
  readonly segmentTrackedStops: number;

  /**
   * Stops in the entire journey the announced segment belongs to. Together with
   * {@link journeyCancelledStops} this places the cancellation in context: `18/30 stops cancelled`
   * reads very differently on a 30-stop run than on a 132-stop one, and a notice never says which
   * it is. Counting only the segment would hide a train that lost its whole first half but still
   * served the rest.
   */
  readonly journeyStops: number;
  /** Stops cancelled across the entire journey, including any outside the announced segment. */
  readonly journeyCancelledStops: number;

  /**
   * The line the feed reports, recorded **only when it differs from the stored `line`**.
   *
   * This is a naming-convention marker, **not** a defect report, and it must never be used to
   * "correct" the stored line. The two sources name the same run differently by design: KVV
   * publishes the corridor a rider recognises (`S51`, `S7`) while the feed follows GTFS's
   * operational short-workings (`S52`, `S71`) or has no line at all for a depot run (`E`). The
   * scraper sides with KVV deliberately — a single-line article uses its own line directly, and
   * `src/train-line-definitions/overrides.ts` forces specific numbers onto the mentioned corridor.
   * Rewriting `line` from this field would file cancellations under lines KVV never mentioned and
   * silently undo those decisions.
   *
   * Its value is longitudinal: a disagreement that recurs is a stable alias worth knowing about,
   * and one that appears once is worth a look.
   */
  readonly feedLine?: string;

  /**
   * The operating company the feed names for the matched journey, recorded **only when it is not
   * the KVV network operator** — the same anomaly-only rule as {@link feedLine}, and for the same
   * reason. The audit this field exists for is "did a verdict come from a stranger's train", and
   * storing `Albtal-Verkehrs-Gesellschaft mbH` on the overwhelming majority of records answers that
   * question by making the reader filter it out. Present-means-unusual inverts that: a grep for the
   * field *is* the audit, and it costs nothing on the normal case.
   *
   * A journey whose operator tokens name a foreign company is rejected outright by
   * {@link matchesNetworkOperator} and never reaches here. What this field catches is the mixed
   * response — an unexpected `train.operator` on a journey some other token vouched for.
   */
  readonly feedOperator?: string;

  /**
   * How many times this trip has been looked up, including the run that produced this verdict.
   * Set by the verification run rather than by classification, and used to stop retrying a trip
   * that will never resolve (a number KVV published on a line no feed knows) on every run for the
   * whole six-day window.
   *
   * Only carried while the verdict is still provisional, since that is the only state
   * {@link needsCheck} consults it in. On a settled verdict the count is spent bookkeeping.
   */
  readonly attempts?: number;
}

function stopEvents(stop: JourneyStop): ReadonlyArray<JourneyStopEvent | null | undefined> {
  return [stop.departure, stop.arrival];
}

/**
 * Whether the feed actually observed the vehicle at this stop.
 *
 * `delay` is **not** a realtime signal: the feed emits `delay: 0` with `time === scheduledTime` on
 * purely timetabled stops, so reading a non-null delay as "tracked" marks an untracked run as
 * fully observed — every one of journey `20260813-19b67970`'s 62 stops carries a delay while only
 * twelve were observed.
 *
 * `isRealTime` is the explicit flag, but it is not always set: journey `20260813-682647f9` leaves
 * it null throughout and still reports second-precision times drifting from the schedule for the
 * second half of its run. A reported time that deviates from the scheduled one is therefore kept
 * as a fallback — a timetable row never deviates.
 */
function isTracked(stop: JourneyStop): boolean {
  return stopEvents(stop).some((event) => {
    if (!event) return false;
    if (event.isRealTime === true) return true;
    return Boolean(event.time && event.scheduledTime && event.time !== event.scheduledTime);
  });
}

/**
 * Whether this stop was cancelled, at stop **or** event level.
 *
 * The feed flags the arrival and departure of a stop independently, and where a cancellation
 * starts or ends mid-journey it sets only those: on journey `20260813-19b67970` the first stop
 * back in service carries `arrival.cancelled` with no stop-level flag. Reading the stop flag alone
 * leaves exactly one stop of a fully cancelled segment uncounted, which downgrades a `cancelled`
 * verdict to `partial`.
 */
function isCancelled(stop: JourneyStop): boolean {
  if (stop.cancelled === true) return true;
  return stopEvents(stop).some((event) => event?.cancelled === true);
}

function scheduledWallClock(stop: JourneyStop): { date: string; time: string } | null {
  const iso = stop.departure?.scheduledTime ?? stop.arrival?.scheduledTime;
  if (!iso) return null;
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return null;
  return formatBerlinWallClock(parsed);
}

function toMinutes(time: string): number {
  const [hours, minutes] = time.split(':');
  return Number(hours) * 60 + Number(minutes);
}

/** Loose token overlap — stop naming differs between KVV notices and the feed. */
function nameTokens(name: string): Set<string> {
  return new Set(
    name
      .toLowerCase()
      .replace(/[^a-zäöüß]+/g, ' ')
      .split(' ')
      .filter((token) => token.length > 2),
  );
}

function overlap(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const token of a) if (b.has(token)) count += 1;
  return count;
}

/**
 * Tolerance when matching the announced departure against the timetable. KVV's notices are not
 * always minute-exact against the feed's schedule (`84793` is published as 05:43 for an 05:45
 * departure). A couple of minutes is safe here because the journey is *already* pinned by train
 * number: the tolerance only decides where inside this run the segment starts, so it cannot
 * accidentally select a different trip.
 */
const DEPARTURE_TOLERANCE_MINUTES = 2;

/** Index of the stop whose scheduled departure matches the announced one, or -1. */
function findDepartureIndex(cancellation: Cancellation, stops: readonly JourneyStop[]): number {
  const wantedMinutes = toMinutes(cancellation.fromTime);
  return stops.findIndex((stop) => {
    const wallClock = scheduledWallClock(stop);
    if (!wallClock || wallClock.date !== cancellation.date) return false;
    return Math.abs(toMinutes(wallClock.time) - wantedMinutes) <= DEPARTURE_TOLERANCE_MINUTES;
  });
}

/**
 * Index of the stop that ends the announced segment. Stop naming differs between KVV notices and
 * the feed ("Söllingen Bahnhof" vs "Söllingen (b Karlsr)"), so the name is matched by token
 * overlap, and the announced arrival time is the fallback when no name is recognisable.
 */
function findSegmentEndIndex(
  cancellation: Cancellation,
  stops: readonly JourneyStop[],
  startIndex: number,
): number {
  const wantedTokens = nameTokens(cancellation.toStop);
  const wantedMinutes = toMinutes(cancellation.toTime);
  let bestByName = -1;
  let bestOverlap = 0;
  let bestByTime = -1;
  let smallestDelta = Number.POSITIVE_INFINITY;

  for (let index = startIndex + 1; index < stops.length; index += 1) {
    const stop = stops[index];
    if (!stop) continue;

    const name = stop.stopPlace?.name;
    if (name) {
      const score = overlap(wantedTokens, nameTokens(name));
      if (score > bestOverlap) {
        bestOverlap = score;
        bestByName = index;
      }
    }

    const wallClock = scheduledWallClock(stop);
    if (wallClock) {
      const delta = Math.abs(toMinutes(wallClock.time) - wantedMinutes);
      if (delta < smallestDelta) {
        smallestDelta = delta;
        bestByTime = index;
      }
    }
  }

  if (bestByName !== -1) return bestByName;
  if (bestByTime !== -1) return bestByTime;
  return stops.length - 1;
}

/**
 * Locate the announced segment inside a journey. A KVV notice names one leg of a longer run, so
 * this is what every count below is scoped to.
 */
export function locateSegment(
  cancellation: Cancellation,
  stops: readonly JourneyStop[],
): { start: number; end: number } | null {
  const start = findDepartureIndex(cancellation, stops);
  if (start === -1) return null;
  return { start, end: findSegmentEndIndex(cancellation, stops, start) };
}

/**
 * Stop tallies behind a verdict. `trackedOutsideSegment` is deliberately internal: it decides
 * whether silence over the segment is meaningful, but it is not part of the published record.
 */
export interface SegmentCounts {
  readonly segmentStops: number;
  readonly segmentCancelledStops: number;
  readonly segmentTrackedStops: number;
  readonly journeyStops: number;
  readonly journeyCancelledStops: number;
  readonly trackedOutsideSegment: number;
}

const NO_COUNTS: SegmentCounts = {
  segmentStops: 0,
  segmentCancelledStops: 0,
  segmentTrackedStops: 0,
  journeyStops: 0,
  journeyCancelledStops: 0,
  trackedOutsideSegment: 0,
};

/** Tally journey and segment stops in a single pass. */
function countSegment(
  stops: readonly JourneyStop[],
  bounds: { start: number; end: number },
): SegmentCounts {
  let segmentStops = 0;
  let segmentCancelledStops = 0;
  let segmentTrackedStops = 0;
  let journeyCancelledStops = 0;
  let trackedOutsideSegment = 0;

  for (let index = 0; index < stops.length; index += 1) {
    const stop = stops[index];
    if (!stop) continue;
    const cancelled = isCancelled(stop);
    const tracked = isTracked(stop);
    if (cancelled) journeyCancelledStops += 1;

    if (index >= bounds.start && index <= bounds.end) {
      segmentStops += 1;
      if (cancelled) segmentCancelledStops += 1;
      if (tracked) segmentTrackedStops += 1;
    } else if (tracked) {
      trackedOutsideSegment += 1;
    }
  }

  return {
    segmentStops,
    segmentCancelledStops,
    segmentTrackedStops,
    journeyStops: stops.length,
    journeyCancelledStops,
    trackedOutsideSegment,
  };
}

/**
 * The verdict rules, in priority order and free of I/O so they can be read and tested as a unit.
 *
 * `journeyCancelled` is the feed's own trip-level flag; it outranks the tallies because it is an
 * explicit statement rather than an inference.
 */
export function determineStatus(
  counts: SegmentCounts,
  journeyCancelled: boolean,
): VerificationStatus {
  const { segmentStops, segmentCancelledStops, segmentTrackedStops, trackedOutsideSegment } =
    counts;

  if (journeyCancelled) return 'cancelled';
  if (segmentStops > 0 && segmentCancelledStops === segmentStops) return 'cancelled';
  if (segmentCancelledStops > 0) return 'partial';
  if (segmentTrackedStops === 0) {
    // Silence only means something when the rest of the same run *was* tracked: that proves the
    // vehicle existed and the feed had coverage, so the announced leg was genuinely not served.
    // Without that control, absence of realtime is absence of evidence.
    return trackedOutsideSegment > 0 ? 'cancelled' : 'no-data';
  }
  return segmentTrackedStops < segmentStops ? 'partial' : 'ran';
}

/** Assemble the published record. Kept as the single place the record's shape is constructed. */
function createVerification(
  status: VerificationStatus,
  counts: SegmentCounts,
  now: Date,
  options: { feedLine?: string; feedOperator?: string } = {},
): TripVerification {
  const { trackedOutsideSegment: _internal, ...published } = counts;
  return {
    status,
    source: VERIFICATION_SOURCE,
    checkedAt: formatBerlinWallClock(now.getTime()).date,
    ...published,
    ...(options.feedLine === undefined ? {} : { feedLine: options.feedLine }),
    ...(options.feedOperator === undefined ? {} : { feedOperator: options.feedOperator }),
  };
}

/** Verdict for a trip whose journey could not be resolved at all. */
export function createUnresolvedVerification(now: Date): TripVerification {
  return createVerification('unresolved', NO_COUNTS, now);
}

/**
 * How the feed names the operator of the KVV Stadtbahn network, in the three forms it publishes:
 * the canonical short code, the company name, and the opaque administration ID.
 *
 * The name and the code are the load-bearing ones — they *say* AVG. The administration ID is only
 * corroborating: `A6` identifies nobody on its own, is suffixed per line (`A6S1`, `A6S11`), and a
 * prefix test on it would happily accept an unrelated `A60`. It is matched last and exactly, so a
 * response that carries an ID and nothing else still resolves.
 */
const NETWORK_OPERATOR_NAME = 'albtal';
const NETWORK_OPERATOR_CODE = 'avg';
const NETWORK_ADMINISTRATION_IDS = new Set(['a6', 'a6s1', 'a6s11']);

/** Every operator token the response carries, normalized. Empty when the feed named none. */
function collectOperatorTokens(details: JourneyDetails): string[] {
  const tokens: string[] = [];
  const push = (value: string | undefined): void => {
    if (value) tokens.push(normalizeGermanText(value));
  };

  push(details.train?.operator);
  push(details.train?.admin);
  // Per-leg administration repeats for every stop, so the first one that carries it is enough.
  for (const stop of details.stops ?? []) {
    const administration = (stop.departure ?? stop.arrival)?.transport?.administration;
    if (!administration) continue;
    push(administration.operatorCode);
    push(administration.operatorName);
    push(administration.administrationID);
    break;
  }
  return tokens;
}

/**
 * Whether this journey belongs to the network KVV publishes about.
 *
 * A Zugnummer is not unique — 20019 alone returns eleven journeys spread over VIAS at Arnhem, ÖBB
 * near Vienna, a Nuremberg U-Bahn and buses in Leipzig, Worms and Losheim. Identity was previously
 * confirmed by finding *a stop* at the announced date and time (±2 minutes), which an unrelated
 * all-day service satisfies by coincidence: stored trip `S7 85586 2026-08-13 19:55 Achern →
 * Karlsruhe Hbf` matched an SNCF Rennes → Brest run and was published as a real verdict.
 *
 * The operator is the key the line name only pretends to be. `journey.find` does not return it, so
 * this cannot narrow the candidate list — it rejects a wrong candidate after its details arrive,
 * and the caller moves on to the next one.
 *
 * A journey that names **no** operator at all is accepted: the fields are absent on some responses,
 * and treating silence as foreign would throw away answers the feed did give us. Naming an operator
 * that is not AVG is a different matter and is rejected. Should KVV ever publish a line another
 * company runs, its journeys are rejected here and the trip is reported `unresolved` — provisional,
 * retried and visible. That is the safe direction to fail; the alternative is a confident verdict
 * computed from a stranger's train.
 */
function namesNetworkOperator(token: string): boolean {
  return (
    token.includes(NETWORK_OPERATOR_NAME) ||
    token === NETWORK_OPERATOR_CODE ||
    NETWORK_ADMINISTRATION_IDS.has(token)
  );
}

export function matchesNetworkOperator(details: JourneyDetails): boolean {
  const tokens = collectOperatorTokens(details);
  if (tokens.length === 0) return true;
  return tokens.some(namesNetworkOperator);
}

/** Classify one stored cancellation against the journey the feed returned for it. */
export function classifyJourney(
  cancellation: Cancellation,
  details: JourneyDetails,
  now: Date,
): TripVerification | null {
  if (!matchesNetworkOperator(details)) return null;

  const stops = details.stops ?? [];
  const bounds = locateSegment(cancellation, stops);
  if (!bounds) return null;

  const counts = countSegment(stops, bounds);
  const status = determineStatus(counts, details.cancelled === true);
  const feedLine = details.train?.line;
  const feedOperator = details.train?.operator;
  const unexpectedOperator =
    feedOperator && !namesNetworkOperator(normalizeGermanText(feedOperator));
  return createVerification(status, counts, now, {
    ...(feedLine && feedLine !== cancellation.line ? { feedLine } : {}),
    ...(unexpectedOperator ? { feedOperator } : {}),
  });
}
