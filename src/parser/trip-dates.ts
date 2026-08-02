/**
 * Dating the trips a notice lists.
 *
 * KVV never writes a date on a trip row: every row carries a bare departure clock time, and the
 * reader is expected to know which day it means. Three things on the page say which:
 *
 *   1. an explicit date row inside the list (`06.07.2026`), which KVV inserts where the list
 *      runs past midnight — authoritative wherever it appears;
 *   2. the order of the rows, which is chronological, so a late-evening row followed by an
 *      early-morning one is the list crossing midnight;
 *   3. the article's publication timestamp, the day the whole list was written for.
 *
 * The one thing that must *not* be used is "trip time is in the past, so it must be tomorrow": a
 * notice keeps listing trips that have already departed (`Nettro_CMS_271645`, published 11:07,
 * still listing that morning's 04:45), so a past departure is usually today's, already run.
 * Dating those a day forward would invent cancellations on a day KVV said nothing about.
 */

import { formatBerlinWallClock } from '../utils/berlin-time.js';
import { ISO_DATE_LENGTH, MINUTES_PER_HOUR, CLOCK_TIME_LENGTH } from '../utils/constants.js';
import { PATTERNS, TRIP_LIST_DATE_ROW_PATTERN } from './patterns.js';

/** The article timestamp a trip list's clock times are read against. */
export interface TripDateAnchor {
  /** ISO date (YYYY-MM-DD) the list was written for. */
  readonly date: string;
  /** That moment's Berlin wall-clock time (HH:MM). */
  readonly clockTime: string;
}

/** One trip row's dating inputs: its departure time, plus any date row that preceded it. */
export interface TripDateInput {
  /** Departure time (HH:MM) of the row, `undefined` when it could not be read. */
  readonly departureTime: string | undefined;
  /** ISO date from an explicit date row in the list, if one governs this row. */
  readonly explicitDate: string | undefined;
}

/**
 * Extracts the moment a notice's trip list is written relative to: its **publication** timestamp
 * (the `DD.MM.YYYY, HH:MM Uhr` line above the headline), not its "Stand".
 *
 * KVV keeps updating a notice's "Stand" through the day it covers while leaving the trip list on
 * the day it was published — `Nettro_CMS_273506` was published at 00:19 for that morning's trips
 * and still carried them at "Stand" 13:50. The "Stand" therefore says when the page was last
 * touched, not which day its trips run.
 *
 * Falls back to the "Stand" when the page carries no publication line, and to the current Berlin
 * wall clock when it carries neither.
 */
export function extractTripDateAnchor(text: string): TripDateAnchor {
  const match = text.match(PATTERNS.STAND_ALT) ?? text.match(PATTERNS.STAND);
  const dateStr = match?.[1];
  const timeStr = match?.[2];
  if (dateStr && timeStr) {
    const [day = '', month = '', year = ''] = dateStr.split('.');
    return { date: `${year}-${month}-${day}`, clockTime: timeStr.slice(0, CLOCK_TIME_LENGTH) };
  }

  // Read "now" as Berlin wall clock: its UTC date is the previous day for anything after midnight
  // Berlin time, which is exactly when night trips get published.
  const { date, time } = formatBerlinWallClock(Date.now());
  return { date, clockTime: time };
}

/**
 * Parses a date row that appears between trip rows (`06.07.2026`, `6.7.`) into an ISO date.
 * A row without a year takes it from `fallbackIsoDate`, whose year the list is running in.
 * Returns `undefined` for anything that is not such a row.
 */
export function parseTripListDateRow(row: string, fallbackIsoDate: string): string | undefined {
  const match = TRIP_LIST_DATE_ROW_PATTERN.exec(row.trim());
  const day = match?.[1];
  const month = match?.[2];
  if (!day || !month) return undefined;
  const year = match[3] ?? fallbackIsoDate.slice(0, 4);
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

/**
 * How far a departure may precede publication before the whole list reads as the next day's.
 *
 * A notice goes out minutes into the disruption it describes, so its first trips can be departing
 * or just departed. Three hours is wider than any observed publishing lag and narrower than the
 * gap between the end of service and the next morning's departures.
 */
const PUBLICATION_LEAD_GRACE_MINUTES = 3 * MINUTES_PER_HOUR;

/** From this hour on, a departure counts as late evening for the midnight-crossing test. */
const LATE_EVENING_MINUTES = 20 * MINUTES_PER_HOUR;

/** Below this hour, a departure counts as early morning for the midnight-crossing test. */
const EARLY_MORNING_MINUTES = 6 * MINUTES_PER_HOUR;

/** Minutes since midnight for an `HH:MM` wall clock, or `null` if unparsable. */
function toMinutesSinceMidnight(clockTime: string | undefined): number | null {
  const match = clockTime === undefined ? null : /^(\d{1,2}):(\d{2})/.exec(clockTime);
  if (!match) return null;
  return Number(match[1]) * MINUTES_PER_HOUR + Number(match[2]);
}

/** Adds one calendar day to an ISO date, unchanged if it is not a well-formed date. */
export function addOneDay(isoDate: string): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined || Number.isNaN(day)) {
    return isoDate;
  }
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, ISO_DATE_LENGTH);
}

/**
 * Whether a whole list belongs to the day *after* its anchor: every departure precedes
 * publication by more than the grace, which is what a late-evening notice for the coming
 * morning looks like (`Nettro_CMS_273833`, published 22:50, listing 03:37–07:06).
 *
 * The "every" is what keeps it apart from a notice retaining already-departed trips: there the
 * list continues past publication, so only a prefix precedes it and the day does not move.
 */
function listRunsAfterMidnight(
  departures: readonly (number | null)[],
  anchorMinutes: number,
): boolean {
  return (
    departures.length > 0 &&
    departures.every(
      (departure) =>
        departure !== null && departure < anchorMinutes - PUBLICATION_LEAD_GRACE_MINUTES,
    )
  );
}

/**
 * Assigns each listed trip row the date it departs on, in list order.
 *
 * The list's base date is the anchor's day — advanced by one when the whole list reads as the
 * coming morning's, and replaced outright wherever an explicit date row appears. On top of that,
 * a step from a late-evening row to an early-morning one opens an *after-midnight tail*: those
 * rows take the day after the base.
 *
 * The tail closes again at the first row back in daytime, because a notice's list is not one
 * chronological run — `Nettro_CMS_273628` lists three blocks, one of which ends at 00:02 while
 * the next starts again at 15:29 that same afternoon. Without closing the tail, every row after
 * an after-midnight one would inherit the extra day.
 *
 * @param inputs - One entry per trip row, in the order the article lists them
 * @param anchor - The article's publication date and Berlin wall-clock time
 * @returns One ISO date per input, in the same order
 */
export function assignTripDates(
  inputs: readonly TripDateInput[],
  anchor: TripDateAnchor,
): string[] {
  const departures = inputs.map((input) => toMinutesSinceMidnight(input.departureTime));
  const anchorMinutes = toMinutesSinceMidnight(anchor.clockTime);
  const hasExplicitDate = inputs.some((input) => input.explicitDate !== undefined);

  // An explicitly dated list says which day each row runs on; only an undated one needs the
  // anchor's day inferred.
  let baseDate =
    !hasExplicitDate && anchorMinutes !== null && listRunsAfterMidnight(departures, anchorMinutes)
      ? addOneDay(anchor.date)
      : anchor.date;

  let isAfterMidnightTail = false;
  let previousDeparture: number | null = null;

  return inputs.map((input, index) => {
    const departure = departures[index] ?? null;
    if (input.explicitDate !== undefined) {
      baseDate = input.explicitDate;
      isAfterMidnightTail = false;
    } else if (departure !== null) {
      if (isAfterMidnightTail) {
        isAfterMidnightTail = departure < EARLY_MORNING_MINUTES;
      } else {
        isAfterMidnightTail =
          previousDeparture !== null &&
          previousDeparture >= LATE_EVENING_MINUTES &&
          departure < EARLY_MORNING_MINUTES;
      }
    }
    previousDeparture = departure;
    return isAfterMidnightTail ? addOneDay(baseDate) : baseDate;
  });
}
