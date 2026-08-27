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
import { formatBerlinWallClock, getBerlinWallClockMs } from '../utils/berlin-time.js';
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
  /** The announced segment could not be resolved confidently within a journey. */
  | 'unresolved';

export type UnresolvedReason =
  /** The stored `trainNumber` is not a number, so the feed could not even be asked. */
  | 'invalid-train-number'
  /** The feed returned no journey at all carrying that number on that date. */
  | 'journey-not-found'
  /**
   * The feed returned journeys with that number, but none of them is an AVG run — a Zugnummer is
   * reused freely, and a KVV trip whose number only turns up on a Köln tram and a München bus was
   * simply never in this feed. Nothing about the match can be improved; the journey is absent.
   */
  | 'journey-not-in-network'
  /**
   * The AVG journey *was* identified, but the announced segment could not be located inside it.
   * Unlike the reason above this one is actionable: it means KVV's endpoint names or times and the
   * feed's stop list disagree, and the counts stored beside it describe the journey as a whole.
   */
  | 'journey-mismatch';

export interface PublicVerificationStatusDefinition {
  readonly id: VerificationStatus;
  readonly label: string;
  readonly description: string;
}

/**
 * The status taxonomy as published in `docs/index.json`, mirroring `PUBLIC_CAUSE_DEFINITIONS`.
 *
 * A consumer reading `status: "cancelled"` off a trip has no way to know what the word was allowed
 * to mean — in particular that it covers both an explicit statement by the feed and an inference
 * drawn from silence. Publishing the taxonomy beside the data is what makes the field usable by
 * anyone who did not write the classifier. Array order is display order, weakest claim last.
 */
export const PUBLIC_VERIFICATION_STATUS_DEFINITIONS: readonly PublicVerificationStatusDefinition[] =
  [
    {
      id: 'cancelled',
      label: 'Cancelled',
      description:
        'The realtime source confirms the announced segment did not run — either it flagged the ' +
        'trip or its stops as cancelled, or it tracked the vehicle either side of a segment it ' +
        'never observed it on.',
    },
    {
      id: 'partial',
      label: 'Partly cancelled',
      description:
        'Only part of the announced segment was cancelled, or only part of it was observed. The ' +
        'notice and reality agree in part.',
    },
    {
      id: 'ran',
      label: 'Ran',
      description:
        'The source observed the vehicle across the whole announced segment with no cancellation ' +
        'flag. The trip KVV announced as cancelled appears to have run.',
    },
    {
      id: 'no-data',
      label: 'No data',
      description:
        'The source knows the journey but holds neither cancellation flags nor realtime for the ' +
        'announced segment, so it says nothing either way. Absence of evidence, not evidence of ' +
        'absence.',
    },
    {
      id: 'unresolved',
      label: 'Unresolved',
      description:
        'No journey matching the trip could be identified in the source, so it was never in a ' +
        'position to answer.',
    },
  ];

/**
 * Realtime feeds a verdict can be derived from.
 *
 * A union rather than a free-form string: adding a second feed is a deliberate, compile-checked
 * change, and every consumer that switches on provenance is forced to handle the new case.
 */
export type VerificationSource = 'bahn.expert' | 'transitous';

/** Default source for the legacy one-source call sites and stored records. */
export const VERIFICATION_SOURCE: VerificationSource = 'bahn.expert';
/**
 * Version of the matching and evidence semantics that produced a verdict.
 *
 * Version 2 added bounded schedule matching, direction-aware boundary evidence, instant-based
 * timestamp comparison, and journey-wide tracking counts. Version 3 scopes operator identity to
 * the announced segment, which matters on through journeys and for ambiguous line names such as
 * S6. Version 4 makes names one signal rather than an absolute gate: it recognises distinctive
 * terminal street names, permits one wider name-confirmed time discrepancy when the other endpoint
 * is exact, falls back to a unique exact schedule pair, and retains journey-wide evidence when a
 * segment still cannot be located. Version 5 accepts the source's explicit whole-journey
 * cancellation even when malformed published endpoint times prevent segment location: an
 * explicitly cancelled journey necessarily cancelled every segment it contained. Version 6 stops
 * inferring a cancellation from any single tracked stop anywhere in the journey and requires the
 * control evidence to sit next to the silent segment or cover a real share of the remainder.
 * Version 7 stops reading a propagated delay forecast as observation: `isRealTime` is authoritative
 * wherever the feed uses it at all, and a deviating time stands in for it only on a journey that
 * carries no flag anywhere and whose delays vary. Both forms of forecast — a whole journey stamped
 * with one delay, and the flat tail that follows a journey's last real sighting — were being
 * counted as tracked, and published `ran` for trips the feed never watched. A stored verdict without
 * this field is version 1. The selection layer uses this only during a recheck: a newer method may
 * correct a confident old false match and may revise its own tracking inference downwards, while
 * the feed's explicit cancellation flags continue to ratchet upward across every version.
 */
export const VERIFICATION_METHOD_VERSION = 7;

export interface VerificationEvidence {
  readonly status: VerificationStatus;
  readonly methodVersion: number;
  /**
   * Which realtime feed answered.
   *
   * This is the source of the selected top-level verdict. When more than one provider answered,
   * `TripVerification.checks` preserves each source's evidence independently so a fallback answer
   * never silently replaces the primary source's result.
   *
   * It is **not** a confidence signal and must not be used to rank verdicts: `retainStrongerVerdict`
   * compares observed stops, and comparing counts across feeds that watch different things would
   * need its own rule rather than an implicit preference for whichever source ran last.
   */
  readonly source: VerificationSource;
  /**
   * Berlin-local date of the check (`2026-08-14`), so a stale verdict is recognisable.
   *
   * Deliberately a date and not a timestamp: provider windows and retry spacing are measured in
   * days. A per-run millisecond stamp only adds bytes to every record and churn to every diff.
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
  /** Stops carrying realtime across the entire journey, including outside the segment. */
  readonly journeyTrackedStops: number;

  /** Tracking outside the announced segment that supports an inferred cancellation. */
  readonly trackedOutsideSegment: number;

  /**
   * Tracking on the stops immediately bordering the announced segment, counted separately because
   * proximity is what makes silence mean cancellation. A vehicle observed at the stop before the
   * segment starts, or at the stop after it ends, was demonstrably running either side of a leg
   * the feed never saw it on. The same observation twenty stops away says only that the run
   * existed at some point. Both are `trackedOutsideSegment`; only this one is decisive on its own.
   *
   * At most 4: the arrival into the origin and the departure out of the destination (the boundary
   * stops' outward-facing halves), plus the neighbouring stops on each side.
   */
  readonly trackedAdjacentStops: number;

  /**
   * The feed's identifier for the journey a verdict was computed from.
   *
   * Stored so a verdict stays auditable. Every other field is a tally, and a tally cannot be
   * re-derived or argued with once the seven-day window has closed — if a verdict looks wrong
   * there is otherwise no way to ask what it was computed from. Matching a stored trip to a
   * journey has already gone wrong once (train number `85586` matched an SNCF Rennes → Brest run
   * before operator scoping existed), and this is the field that makes the next such case
   * diagnosable rather than merely suspicious.
   *
   * Absent on `unresolved` verdicts that never reached a journey, and on records written before
   * method version 6.
   */
  readonly journeyId?: string;

  /** Present only when the source explicitly marked the whole journey cancelled. */
  readonly journeyCancelled?: true;

  /** Why no journey or segment could be resolved; present only on `unresolved` verdicts. */
  readonly unresolvedReason?: UnresolvedReason;

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
   * whole seven-day window.
   *
   * Only carried while the verdict is still provisional, since that is the only state
   * {@link needsCheck} consults it in. On a settled verdict the count is spent bookkeeping.
   */
  readonly attempts?: number;
}

export type VerificationAgreement = 'single-source' | 'corroborated' | 'conflicting';

/**
 * Published verification result plus optional evidence from the other providers consulted.
 *
 * The original top-level fields stay intact for backwards compatibility: they are the selected
 * verdict, and old consumers can continue to read them without knowing that a second source was
 * tried. `checks` appears only when more than one source answered, keyed by source so repeated
 * four-hour runs update evidence idempotently rather than append duplicate observations.
 */
export interface TripVerification extends VerificationEvidence {
  readonly checks?: Partial<Record<VerificationSource, VerificationEvidence>>;
  readonly agreement?: VerificationAgreement;
}

function stopEvents(stop: JourneyStop): ReadonlyArray<JourneyStopEvent | null | undefined> {
  return [stop.departure, stop.arrival];
}

/**
 * Whether the reported time differs from the timetable at all. On its own this says nothing about
 * observation — see {@link acceptsDeviationAsObservation} for when it is allowed to.
 */
function deviatesFromSchedule(event: JourneyStopEvent | null | undefined): boolean {
  if (!event?.time || !event.scheduledTime) return false;

  // Compare instants, not their serializations. The same timestamp can be written as `Z` or with
  // an explicit offset; treating those strings as different manufactures realtime observations.
  const actualMs = Date.parse(event.time);
  const scheduledMs = Date.parse(event.scheduledTime);
  return !Number.isNaN(actualMs) && !Number.isNaN(scheduledMs) && actualMs !== scheduledMs;
}

/**
 * Whether a deviating time may stand in for the realtime flag **on this journey**.
 *
 * The fallback exists because the flag is not always set: journey `20260813-682647f9` leaves
 * `isRealTime` null throughout and still reports times drifting from the schedule across the
 * second half of its run. Those deviations carry three different delay values — a vehicle being
 * watched.
 *
 * A forecast looks different. When the feed knows only that a run is late it applies **one** delay
 * to every remaining stop, and the resulting times deviate from the schedule at every single stop
 * without a metre of it having been observed. Journeys `20260822-82743995`, `20260822-604a4ebb`
 * and `20260822-d6b912ae` — the Freudenstadt shuttle on a day KVV had announced the whole S8 as
 * cancelled for lack of staff — each carry no realtime flag at all and a single delay value across
 * every stop. Read as observation, that is a fully tracked segment, and two of the three were
 * published as `ran`: the strongest claim this classifier makes, drawn from a feed that had not
 * seen the train.
 *
 * So the fallback applies only to journeys where the flag is **never** used. Where the feed sets
 * `isRealTime` anywhere, it is telling us which stops it observed, and its silence on the others is
 * an answer rather than a gap to paper over — journey `20260822-d413a3fe` flags eleven events after
 * Rastatt and leaves the announced Forbach → Rastatt leg carrying nothing but a flat `delay: 41`,
 * which the journey-wide form of this test still read as a fully tracked segment and published as
 * `ran`. Only where no event carries the flag at all does a deviating time stand in for it, and
 * then only if the deviations resolve to more than one delay: several delay values are a vehicle
 * being watched, one restated number is a forecast.
 */
function acceptsDeviationAsObservation(stops: readonly JourneyStop[]): boolean {
  const delays = new Set<number | null | undefined>();
  for (const stop of stops) {
    for (const event of stopEvents(stop)) {
      if (event?.isRealTime === true) return false;
      if (deviatesFromSchedule(event)) delays.add(event?.delay);
    }
  }
  return delays.size > 1;
}

/**
 * Whether the feed actually observed the vehicle at this stop.
 *
 * `delay` is **not** a realtime signal: the feed emits `delay: 0` with `time === scheduledTime` on
 * purely timetabled stops, so reading a non-null delay as "tracked" marks an untracked run as
 * fully observed — every one of journey `20260813-19b67970`'s 62 stops carries a delay while only
 * twelve were observed.
 *
 * `isRealTime` is the explicit flag and settles it alone. Where it is null, a deviating time may
 * stand in for it, but only on a journey whose deviations `acceptsDeviationAsObservation` has
 * cleared of being one propagated forecast.
 */
function isTrackedEvent(
  event: JourneyStopEvent | null | undefined,
  acceptsDeviation: boolean,
): boolean {
  if (!event) return false;
  if (event.isRealTime === true) return true;
  return acceptsDeviation && deviatesFromSchedule(event);
}

function isTracked(stop: JourneyStop, acceptsDeviation: boolean): boolean {
  return stopEvents(stop).some((event) => isTrackedEvent(event, acceptsDeviation));
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

function scheduledWallClock(
  stop: JourneyStop,
  preferredEvent: 'arrival' | 'departure',
): { date: string; time: string } | null {
  const iso =
    preferredEvent === 'departure'
      ? (stop.departure?.scheduledTime ?? stop.arrival?.scheduledTime)
      : (stop.arrival?.scheduledTime ?? stop.departure?.scheduledTime);
  if (!iso) return null;
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return null;
  return formatBerlinWallClock(parsed);
}

function toMinutes(time: string): number {
  const [hours, minutes] = time.split(':');
  return Number(hours) * 60 + Number(minutes);
}

/**
 * Canonical stop-name tokens. KVV and the feed abbreviate both place and street suffixes
 * differently (`KA`/`Karlsruhe`, `Tullastr.`/`Tullastraße`, `Bf.`/`Bahnhof`). Station words are
 * deliberately dropped: the locality distinguishes `Freudenstadt Bahnhof` from other stops much
 * better than a generic `Bahnhof` token does.
 */
function nameTokens(name: string): string[] {
  const aliases: Readonly<Record<string, string>> = {
    ka: 'karlsruhe',
    karlsr: 'karlsruhe',
    kniel: 'knielingen',
    bf: '',
    hbf: 'haupt',
    bahnhof: '',
    pl: 'platz',
  };

  return [
    ...new Set(
      normalizeGermanText(name)
        .replace(/-/g, ' ')
        .split(' ')
        .map((token) => aliases[token] ?? token)
        .map((token) => token.replace(/str(?:asse)?$/, ''))
        .map((token) => token.replace(/hauptbahnhof$/, 'haupt').replace(/bahnhof$/, ''))
        .filter((token) => token.length > 2),
    ),
  ];
}

/** One-edit tolerance for source typos such as `Wörh` instead of `Wörth`. */
function tokensMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1 || Math.min(a.length, b.length) < 5) return false;

  let edits = 0;
  let ai = 0;
  let bi = 0;
  while (ai < a.length && bi < b.length) {
    if (a[ai] === b[bi]) {
      ai += 1;
      bi += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (a.length > b.length) ai += 1;
    else if (b.length > a.length) bi += 1;
    else {
      ai += 1;
      bi += 1;
    }
  }
  return edits + (ai < a.length || bi < b.length ? 1 : 0) <= 1;
}

/** Dice similarity with one-to-one fuzzy token matching. */
function nameSimilarity(wantedName: string, actualName: string): number {
  const wanted = nameTokens(wantedName);
  if (wanted.length === 0) return 0;

  // A slash separates aliases in names such as `Tullastraße/Alter Schlachthof, Karlsruhe`, while
  // text after a comma is often only the municipality. Score those meaningful variants as well
  // as the full name. The final street token is also a safe, useful variant: KVV publishes the
  // short `Rheinbergstraße`, while the feed publishes `Karlsruhe-Kniel. Rheinbergstr.`. Using an
  // arbitrary final token would be too broad; restricting this to street names keeps locality
  // qualifiers such as `Linkenheim-Hochstetten` from becoming stop identities.
  const beforeComma = actualName.split(',')[0] ?? actualName;
  const terminalStreet = beforeComma.match(/[\p{L}-]+str(?:aße|asse|\.)?$/iu)?.[0];
  const variants = [
    ...new Set([
      actualName,
      beforeComma,
      ...beforeComma.split('/'),
      ...(terminalStreet ? [terminalStreet] : []),
    ]),
  ];
  let best = 0;

  for (const variant of variants) {
    const actual = nameTokens(variant);
    if (actual.length === 0) continue;
    const used = new Set<number>();
    let matches = 0;
    for (const wantedToken of wanted) {
      const exact = actual.findIndex((token, index) => !used.has(index) && token === wantedToken);
      const index =
        exact !== -1
          ? exact
          : actual.findIndex(
              (token, candidateIndex) =>
                !used.has(candidateIndex) && tokensMatch(wantedToken, token),
            );
      if (index !== -1) {
        used.add(index);
        matches += 1;
      }
    }
    best = Math.max(best, (2 * matches) / (wanted.length + actual.length));
  }
  return best;
}

const MINIMUM_NAME_SIMILARITY = 0.55;
/** Reject a same-named journey whose schedule does not describe the announced trip. */
const MAX_ENDPOINT_TIME_DELTA_MINUTES = 15;
/** Wider tolerance is safe only when both names match and the other endpoint is effectively exact. */
const MAX_ANCHORED_ENDPOINT_TIME_DELTA_MINUTES = 30;
const MAX_ANCHOR_TIME_DELTA_MINUTES = 2;
const MINIMUM_ANCHORED_NAME_SIMILARITY = 0.8;
/** Names may be omitted only when the complete ordered schedule pair is unique at exact precision. */
const MAX_TIME_ONLY_DELTA_MINUTES = 2;

interface StopMatch {
  readonly index: number;
  readonly nameSimilarity: number;
  readonly timeDeltaMinutes: number;
}

/**
 * Pick a stop using name first and time second. Time alone is not identity: on a dense Stadtbahn
 * corridor an unrelated stop routinely departs in the same minute. The old time-only start match
 * turned `Wörh Badepark 08:05` into Philippstraße 08:03 and published a confident verdict for
 * the wrong segment.
 */
function findBestStopMatch(
  wantedName: string,
  wantedDate: string,
  wantedTime: string,
  stops: readonly JourneyStop[],
  firstIndex: number,
  preferredEvent: 'arrival' | 'departure',
  maxTimeDeltaMinutes = MAX_ENDPOINT_TIME_DELTA_MINUTES,
): StopMatch | null {
  const wantedMs = getBerlinWallClockMs(wantedDate, wantedTime);
  let best: StopMatch | null = null;

  for (let index = firstIndex; index < stops.length; index += 1) {
    const stop = stops[index];
    const actualName = stop?.stopPlace?.name;
    const wallClock = stop ? scheduledWallClock(stop, preferredEvent) : null;
    if (!actualName || !wallClock) continue;

    const similarity = nameSimilarity(wantedName, actualName);
    if (similarity < MINIMUM_NAME_SIMILARITY) continue;
    const actualMs = getBerlinWallClockMs(wallClock.date, wallClock.time);
    const timeDeltaMinutes = Math.abs(actualMs - wantedMs) / (60 * 1000);
    if (timeDeltaMinutes > maxTimeDeltaMinutes) continue;
    const candidate: StopMatch = {
      index,
      nameSimilarity: similarity,
      timeDeltaMinutes,
    };
    if (
      !best ||
      candidate.nameSimilarity > best.nameSimilarity ||
      (candidate.nameSimilarity === best.nameSimilarity &&
        candidate.timeDeltaMinutes < best.timeDeltaMinutes)
    ) {
      best = candidate;
    }
  }
  return best;
}

function nextDate(date: string): string {
  const noonUtc = new Date(`${date}T12:00:00.000Z`);
  noonUtc.setUTCDate(noonUtc.getUTCDate() + 1);
  return noonUtc.toISOString().slice(0, 10);
}

/**
 * Index of the stop that ends the announced segment. Stop naming differs between KVV notices and
 * the feed ("Söllingen Bahnhof" vs "Söllingen (b Karlsr)"), so the name is matched by normalized
 * token overlap and the scheduled arrival must remain inside the confidence window.
 */
function findSegmentEndMatch(
  cancellation: Cancellation,
  stops: readonly JourneyStop[],
  startIndex: number,
  maxTimeDeltaMinutes = MAX_ENDPOINT_TIME_DELTA_MINUTES,
): StopMatch | null {
  const crossesMidnight = toMinutes(cancellation.toTime) < toMinutes(cancellation.fromTime);
  const wantedDate = crossesMidnight ? nextDate(cancellation.date) : cancellation.date;
  return findBestStopMatch(
    cancellation.toStop,
    wantedDate,
    cancellation.toTime,
    stops,
    startIndex + 1,
    'arrival',
    maxTimeDeltaMinutes,
  );
}

function locateNamedSegment(
  cancellation: Cancellation,
  stops: readonly JourneyStop[],
  maxTimeDeltaMinutes: number,
): {
  bounds: { start: number; end: number };
  startDelta: number;
  endDelta: number;
  startSimilarity: number;
  endSimilarity: number;
} | null {
  const start = findBestStopMatch(
    cancellation.fromStop,
    cancellation.date,
    cancellation.fromTime,
    stops,
    0,
    'departure',
    maxTimeDeltaMinutes,
  );
  if (!start) return null;
  const end = findSegmentEndMatch(cancellation, stops, start.index, maxTimeDeltaMinutes);
  if (!end) return null;
  return {
    bounds: { start: start.index, end: end.index },
    startDelta: start.timeDeltaMinutes,
    endDelta: end.timeDeltaMinutes,
    startSimilarity: start.nameSimilarity,
    endSimilarity: end.nameSimilarity,
  };
}

function findScheduleMatches(
  wantedDate: string,
  wantedTime: string,
  stops: readonly JourneyStop[],
  firstIndex: number,
  preferredEvent: 'arrival' | 'departure',
): StopMatch[] {
  const wantedMs = getBerlinWallClockMs(wantedDate, wantedTime);
  const matches: StopMatch[] = [];
  for (let index = firstIndex; index < stops.length; index += 1) {
    const stop = stops[index];
    const wallClock = stop ? scheduledWallClock(stop, preferredEvent) : null;
    if (!wallClock) continue;
    const actualMs = getBerlinWallClockMs(wallClock.date, wallClock.time);
    const timeDeltaMinutes = Math.abs(actualMs - wantedMs) / (60 * 1000);
    if (timeDeltaMinutes <= MAX_TIME_ONLY_DELTA_MINUTES) {
      matches.push({ index, nameSimilarity: 0, timeDeltaMinutes });
    }
  }
  return matches;
}

/** Locate a segment by schedule only when exactly one ordered endpoint pair fits. */
function locateUniqueScheduleSegment(
  cancellation: Cancellation,
  stops: readonly JourneyStop[],
): { start: number; end: number } | null {
  const crossesMidnight = toMinutes(cancellation.toTime) < toMinutes(cancellation.fromTime);
  const endDate = crossesMidnight ? nextDate(cancellation.date) : cancellation.date;
  const starts = findScheduleMatches(
    cancellation.date,
    cancellation.fromTime,
    stops,
    0,
    'departure',
  );
  const pairs = starts.flatMap((start) =>
    findScheduleMatches(endDate, cancellation.toTime, stops, start.index + 1, 'arrival').map(
      (end) => ({ start: start.index, end: end.index }),
    ),
  );
  return pairs.length === 1 ? (pairs[0] ?? null) : null;
}

/**
 * Locate the announced segment inside a journey. A KVV notice names one leg of a longer run, so
 * this is what every count below is scoped to.
 */
export function locateSegment(
  cancellation: Cancellation,
  stops: readonly JourneyStop[],
): { start: number; end: number } | null {
  const named = locateNamedSegment(cancellation, stops, MAX_ENDPOINT_TIME_DELTA_MINUTES);
  if (named) return named.bounds;

  // KVV occasionally publishes one stale endpoint time. Two matching names plus one exact time
  // still identify the run strongly; this recovered live S1 10004 (05:52 published vs 05:33 in
  // the timetable, with its destination exact) without accepting S5 84805, whose two times were
  // both about half an hour away from the only journey returned.
  const anchored = locateNamedSegment(
    cancellation,
    stops,
    MAX_ANCHORED_ENDPOINT_TIME_DELTA_MINUTES,
  );
  if (
    anchored &&
    Math.min(anchored.startDelta, anchored.endDelta) <= MAX_ANCHOR_TIME_DELTA_MINUTES &&
    anchored.startSimilarity >= MINIMUM_ANCHORED_NAME_SIMILARITY &&
    anchored.endSimilarity >= MINIMUM_ANCHORED_NAME_SIMILARITY
  ) {
    return anchored.bounds;
  }

  // Names differ much more freely than schedules. The exact train number, date and operator are
  // checked by the caller; here both endpoint clocks must additionally form one unique ordered
  // pair. Ambiguous dense-corridor times deliberately remain unresolved.
  return locateUniqueScheduleSegment(cancellation, stops);
}

/**
 * Stop tallies behind a verdict. `trackedOutsideSegment` is retained because it is the decisive
 * evidence when an untracked segment is classified as cancelled.
 */
export interface SegmentCounts {
  readonly segmentStops: number;
  readonly segmentCancelledStops: number;
  readonly segmentTrackedStops: number;
  readonly journeyStops: number;
  readonly journeyCancelledStops: number;
  readonly journeyTrackedStops: number;
  readonly trackedOutsideSegment: number;
  readonly trackedAdjacentStops: number;
}

const NO_COUNTS: SegmentCounts = {
  segmentStops: 0,
  segmentCancelledStops: 0,
  segmentTrackedStops: 0,
  journeyStops: 0,
  journeyCancelledStops: 0,
  journeyTrackedStops: 0,
  trackedOutsideSegment: 0,
  trackedAdjacentStops: 0,
};

/**
 * Evidence at a segment boundary belongs to one side of the stop only. An observed arrival at the
 * origin describes the preceding leg; an observed departure at the destination describes the
 * following leg. Letting either leak into the segment can turn a fully cancelled leg into a
 * partially tracked one (or vice versa).
 */
function segmentEvents(
  stop: JourneyStop,
  index: number,
  bounds: { start: number; end: number },
): ReadonlyArray<JourneyStopEvent | null | undefined> {
  if (index === bounds.start) return [stop.departure];
  if (index === bounds.end) return [stop.arrival];
  return stopEvents(stop);
}

function isSegmentCancelled(
  stop: JourneyStop,
  index: number,
  bounds: { start: number; end: number },
): boolean {
  return (
    stop.cancelled === true ||
    segmentEvents(stop, index, bounds).some((event) => event?.cancelled === true)
  );
}

function isSegmentTracked(
  stop: JourneyStop,
  index: number,
  bounds: { start: number; end: number },
  acceptsDeviation: boolean,
): boolean {
  return segmentEvents(stop, index, bounds).some((event) =>
    isTrackedEvent(event, acceptsDeviation),
  );
}

/** Tally journey and segment stops in a single pass. */
function countSegment(
  stops: readonly JourneyStop[],
  bounds: { start: number; end: number },
): SegmentCounts {
  let segmentStops = 0;
  let segmentCancelledStops = 0;
  let segmentTrackedStops = 0;
  let journeyCancelledStops = 0;
  let journeyTrackedStops = 0;
  let trackedOutsideSegment = 0;
  let trackedAdjacentStops = 0;
  const acceptsDeviation = acceptsDeviationAsObservation(stops);

  for (let index = 0; index < stops.length; index += 1) {
    const stop = stops[index];
    if (!stop) continue;
    const cancelled = isCancelled(stop);
    const tracked = isTracked(stop, acceptsDeviation);
    if (cancelled) journeyCancelledStops += 1;
    if (tracked) journeyTrackedStops += 1;

    if (index >= bounds.start && index <= bounds.end) {
      const segmentCancelled = isSegmentCancelled(stop, index, bounds);
      const segmentTracked = isSegmentTracked(stop, index, bounds, acceptsDeviation);
      segmentStops += 1;
      if (segmentCancelled) segmentCancelledStops += 1;
      if (segmentTracked) segmentTrackedStops += 1;
      // The arrival into the origin and departure from the destination belong to the adjacent
      // legs. They must not inflate segment tracking, but they are still valid control evidence
      // that the feed observed the rest of this run — and being on the boundary stop itself, they
      // are the closest such evidence there is.
      if (
        (index === bounds.start && isTrackedEvent(stop.arrival, acceptsDeviation)) ||
        (index === bounds.end && isTrackedEvent(stop.departure, acceptsDeviation))
      ) {
        trackedOutsideSegment += 1;
        trackedAdjacentStops += 1;
      }
    } else if (tracked) {
      trackedOutsideSegment += 1;
      if (index === bounds.start - 1 || index === bounds.end + 1) trackedAdjacentStops += 1;
    }
  }

  return {
    segmentStops,
    segmentCancelledStops,
    segmentTrackedStops,
    journeyStops: stops.length,
    journeyCancelledStops,
    journeyTrackedStops,
    trackedOutsideSegment,
    trackedAdjacentStops,
  };
}

/**
 * Share of the untouched remainder that must carry realtime before distant tracking alone is
 * accepted as proof that a silent segment was cancelled. Half is deliberately unambitious: it only
 * has to separate a run the feed genuinely watched from one it barely saw.
 */
const MINIMUM_CONTROL_TRACKING_RATIO = 0.5;

/**
 * Whether the journey outside the announced segment was observed well enough that silence *on* the
 * segment means the leg was not served.
 *
 * Any tracking anywhere used to be enough, which reads far too much into a single stop. Stored
 * trip `S5 84820 2026-08-18` inferred a cancellation of thirteen silent stops from five observed
 * ones scattered across the remaining twenty-seven: a feed that saw under a fifth of a run is not
 * a feed whose silence proves anything. Two rules now let the inference through, and they answer
 * different questions:
 *
 * - **Adjacency** — the vehicle was observed immediately either side of the segment, so it existed
 *   at the very moments it should have been serving the leg. One such stop settles it.
 * - **Coverage** — failing that, the feed must have watched a real share of the remainder, so that
 *   an unwatched segment stands out against a watched run rather than against more silence.
 *
 * Everything else is `no-data`: absence of evidence, reported as such.
 */
function hasCancellationControl(counts: SegmentCounts): boolean {
  const { journeyStops, segmentStops, trackedOutsideSegment, trackedAdjacentStops } = counts;
  if (trackedOutsideSegment === 0) return false;
  if (trackedAdjacentStops > 0) return true;
  const controlStops = journeyStops - segmentStops;
  return controlStops > 0 && trackedOutsideSegment / controlStops >= MINIMUM_CONTROL_TRACKING_RATIO;
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
  const { segmentStops, segmentCancelledStops, segmentTrackedStops } = counts;

  if (journeyCancelled) return 'cancelled';
  if (segmentStops > 0 && segmentCancelledStops === segmentStops) return 'cancelled';
  if (segmentCancelledStops > 0) return 'partial';
  if (segmentTrackedStops === 0) {
    // Silence only means something when the rest of the same run *was* tracked well enough to
    // prove the vehicle existed and the feed was watching it. Without that control, absence of
    // realtime is absence of evidence — see `hasCancellationControl`.
    return hasCancellationControl(counts) ? 'cancelled' : 'no-data';
  }
  return segmentTrackedStops < segmentStops ? 'partial' : 'ran';
}

/** Assemble the published record. Kept as the single place the record's shape is constructed. */
function createVerification(
  status: VerificationStatus,
  counts: SegmentCounts,
  now: Date,
  options: {
    source?: VerificationSource;
    feedLine?: string;
    feedOperator?: string;
    journeyCancelled?: true;
    journeyId?: string;
    unresolvedReason?: UnresolvedReason;
  } = {},
): TripVerification {
  return {
    status,
    methodVersion: VERIFICATION_METHOD_VERSION,
    source: options.source ?? VERIFICATION_SOURCE,
    checkedAt: formatBerlinWallClock(now.getTime()).date,
    ...counts,
    ...(options.journeyCancelled ? { journeyCancelled: true as const } : {}),
    ...(options.journeyId === undefined ? {} : { journeyId: options.journeyId }),
    ...(options.unresolvedReason ? { unresolvedReason: options.unresolvedReason } : {}),
    ...(options.feedLine === undefined ? {} : { feedLine: options.feedLine }),
    ...(options.feedOperator === undefined ? {} : { feedOperator: options.feedOperator }),
  };
}

/**
 * Verdict for a trip whose journey could not be resolved at all.
 *
 * `journeyId` is passed on the reasons that reached a journey, so even a verdict that concluded
 * nothing still says which journey it concluded it from.
 */
export function createUnresolvedVerification(
  now: Date,
  unresolvedReason: UnresolvedReason = 'journey-not-found',
  journeyId?: string,
  source: VerificationSource = VERIFICATION_SOURCE,
): TripVerification {
  return createVerification('unresolved', NO_COUNTS, now, {
    source,
    unresolvedReason,
    ...(journeyId === undefined ? {} : { journeyId }),
  });
}

/**
 * Whether these details are the AVG journey the stored trip names — number, operator and nothing
 * else. Deliberately weaker than {@link classifyJourney}: it answers "was our train in the feed at
 * all", which is what separates an absent journey from one whose segment we failed to locate.
 */
export function identifiesNetworkJourney(
  cancellation: Cancellation,
  details: JourneyDetails,
): boolean {
  const expectedJourneyNumber = Number(cancellation.trainNumber);
  if (details.train?.journeyNumber !== expectedJourneyNumber) return false;
  return matchesNetworkOperator(details);
}

/**
 * How the feed names the operator of the KVV Stadtbahn network, in the three forms it publishes:
 * the canonical short code, the company name, and the opaque administration ID.
 *
 * The name and the code are the load-bearing ones — they *say* AVG. The administration ID is only
 * corroborating: `A6` identifies nobody on its own, is suffixed per line (`A6S1`, `A6S11`,
 * `A6S12`), and a prefix test on it would happily accept an unrelated `A60`. It is matched last
 * and exactly, so a response that carries an ID and nothing else still resolves.
 */
const NETWORK_OPERATOR_NAME = 'albtal';
const NETWORK_OPERATOR_CODE = 'avg';
const NETWORK_ADMINISTRATION_IDS = new Set(['a6', 'a6s1', 'a6s11', 'a6s12']);

function pushOperatorTokens(
  tokens: string[],
  administration:
    | {
        readonly administrationID?: string;
        readonly operatorCode?: string;
        readonly operatorName?: string;
      }
    | undefined,
): void {
  if (!administration) return;
  const values = [
    administration.operatorCode,
    administration.operatorName,
    administration.administrationID,
  ];
  for (const value of values) {
    if (value) tokens.push(normalizeGermanText(value));
  }
}

/** Every operator token the response carries, normalized. Empty when the feed named none. */
function collectOperatorTokens(
  details: JourneyDetails,
  bounds?: { start: number; end: number },
): string[] {
  const tokens: string[] = [];
  const push = (value: string | undefined): void => {
    if (value) tokens.push(normalizeGermanText(value));
  };

  const stops = details.stops ?? [];
  if (bounds) {
    for (let index = bounds.start; index <= bounds.end; index += 1) {
      const stop = stops[index];
      if (!stop) continue;
      for (const event of segmentEvents(stop, index, bounds)) {
        pushOperatorTokens(tokens, event?.transport?.administration);
      }
    }
    // Per-event administration describes the actual leg and wins over a journey-wide label. This
    // is essential for through journeys that change operator. Fall back only when the segment is
    // silent, which is common in sparse responses.
    if (tokens.length > 0) return tokens;
  } else {
    for (const stop of stops) {
      for (const event of stopEvents(stop)) {
        pushOperatorTokens(tokens, event?.transport?.administration);
      }
    }
  }

  push(details.train?.operator);
  push(details.train?.admin);
  return tokens;
}

/**
 * Whether this journey segment belongs to the AVG network these notices publish about.
 *
 * A Zugnummer is not unique — 20019 alone returns eleven journeys spread over VIAS at Arnhem, ÖBB
 * near Vienna, a Nuremberg U-Bahn and buses in Leipzig, Worms and Losheim. Identity was previously
 * confirmed by finding *a stop* at the announced date and time (±2 minutes), which an unrelated
 * all-day service satisfies by coincidence: stored trip `S7 85586 2026-08-13 19:55 Achern →
 * Karlsruhe Hbf` matched an SNCF Rennes → Brest run and was published as a real verdict.
 *
 * The operator is the key the line name only pretends to be. KVV has two unrelated S6 corridors,
 * one operated by AVG and one by DB, so even an exact line match is not identity. `journey.find`
 * does not return the operator, so this cannot narrow the candidate list — it rejects a wrong
 * candidate after its details arrive, and the caller moves on to the next one.
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

export function matchesNetworkOperator(
  details: JourneyDetails,
  bounds?: { start: number; end: number },
): boolean {
  const tokens = collectOperatorTokens(details, bounds);
  if (tokens.length === 0) return true;
  // Conflicting explicit identities are ambiguity, not permission. Current AVG responses repeat
  // compatible name/code/admin tokens; requiring all of them to agree prevents one stray AVG leg
  // elsewhere in a mixed journey from vouching for a foreign announced segment.
  return tokens.every(namesNetworkOperator);
}

function countJourney(stops: readonly JourneyStop[]): SegmentCounts {
  const acceptsDeviation = acceptsDeviationAsObservation(stops);
  return {
    segmentStops: 0,
    segmentCancelledStops: 0,
    segmentTrackedStops: 0,
    journeyStops: stops.length,
    journeyCancelledStops: stops.filter(isCancelled).length,
    journeyTrackedStops: stops.filter((stop) => isTracked(stop, acceptsDeviation)).length,
    // The segment is unknown, so no tracked stop can honestly be labelled inside, outside or
    // adjacent to it.
    trackedOutsideSegment: 0,
    trackedAdjacentStops: 0,
  };
}

/**
 * Preserve evidence from a strongly identified journey whose announced segment remains unknown.
 *
 * This deliberately requires the exact stored line in addition to train number, network operator
 * and service date. Line aliases are safe only after endpoint matching; without a segment they
 * would attach S5 journey evidence to KVV's unrelated S4 84805 typo. The unresolved status keeps
 * the journey counts contextual rather than claiming they describe the announced segment.
 */
export function createJourneyMismatchVerification(
  cancellation: Cancellation,
  details: JourneyDetails,
  now: Date,
  source: VerificationSource = VERIFICATION_SOURCE,
): TripVerification | null {
  const expectedJourneyNumber = Number(cancellation.trainNumber);
  if (details.train?.journeyNumber !== expectedJourneyNumber) return null;
  if (details.train?.line !== cancellation.line) return null;
  if (!matchesNetworkOperator(details)) return null;

  const stops = details.stops ?? [];
  const runsOnDate = stops.some((stop) =>
    stopEvents(stop).some((event) => {
      if (!event?.scheduledTime) return false;
      const parsed = Date.parse(event.scheduledTime);
      return !Number.isNaN(parsed) && formatBerlinWallClock(parsed).date === cancellation.date;
    }),
  );
  if (!runsOnDate || stops.length === 0) return null;

  const feedOperator = details.train?.operator;
  const unexpectedOperator =
    feedOperator && !namesNetworkOperator(normalizeGermanText(feedOperator));
  const journeyCancelled = details.cancelled === true;
  return createVerification(
    journeyCancelled ? 'cancelled' : 'unresolved',
    countJourney(stops),
    now,
    {
      source,
      ...(journeyCancelled ? { journeyCancelled: true } : { unresolvedReason: 'journey-mismatch' }),
      ...(details.journeyId === undefined ? {} : { journeyId: details.journeyId }),
      ...(unexpectedOperator ? { feedOperator } : {}),
    },
  );
}

/** Classify one stored cancellation against the journey the feed returned for it. */
export function classifyJourney(
  cancellation: Cancellation,
  details: JourneyDetails,
  now: Date,
  source: VerificationSource = VERIFICATION_SOURCE,
): TripVerification | null {
  const expectedJourneyNumber = Number(cancellation.trainNumber);
  if (
    details.train?.journeyNumber !== undefined &&
    details.train.journeyNumber !== expectedJourneyNumber
  ) {
    return null;
  }
  const stops = details.stops ?? [];
  const bounds = locateSegment(cancellation, stops);
  if (!bounds) return null;
  if (!matchesNetworkOperator(details, bounds)) return null;

  const counts = countSegment(stops, bounds);
  const status = determineStatus(counts, details.cancelled === true);
  const feedLine = details.train?.line;
  const feedOperator = details.train?.operator;
  const unexpectedOperator =
    feedOperator && !namesNetworkOperator(normalizeGermanText(feedOperator));
  return createVerification(status, counts, now, {
    source,
    ...(details.cancelled === true ? { journeyCancelled: true } : {}),
    ...(details.journeyId === undefined ? {} : { journeyId: details.journeyId }),
    ...(feedLine && feedLine !== cancellation.line ? { feedLine } : {}),
    ...(unexpectedOperator ? { feedOperator } : {}),
  });
}
