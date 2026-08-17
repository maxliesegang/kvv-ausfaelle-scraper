/**
 * Which stored trips a verification run should look at, and when to stop looking.
 *
 * Kept apart from `./verify.ts`: that module decides *what happened* to a trip, this one decides
 * *whether to ask*. Both are pure, so the run script stays orchestration only.
 */

import type { Cancellation } from '../types.js';
import { formatBerlinWallClock, getBerlinWallClockMs } from '../utils/berlin-time.js';
import { MAX_LOOKBACK_DAYS } from './bahn-expert.js';
import type { TripVerification } from './verify.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Grace period after departure before a trip is judged, so a running trip is not called missing. */
export const SETTLE_MS = 30 * 60 * 1000;

/**
 * Provisional verdicts are retried on later runs — realtime data can arrive late — but only a few
 * days. Some trips never resolve at all (KVV occasionally publishes a train number on a line no
 * feed knows), and without a bound those would be looked up on every run for the whole seven-day
 * window only to produce the same answer. Attempts are spaced by Berlin-local date so a workflow
 * running every four hours cannot spend the whole budget before late realtime arrives.
 */
export const MAX_ATTEMPTS = 3;

/** Verdicts that may still change, and so are worth asking about again. */
const PROVISIONAL_STATUSES = new Set<TripVerification['status']>([
  'partial',
  'no-data',
  'unresolved',
]);

/**
 * Whether a trip can be checked at all: departed (plus a settling grace period) and still inside
 * the feed's lookback window. Trips older than the window are permanently unverifiable.
 */
export function isVerifiable(cancellation: Cancellation, nowMs: number): boolean {
  const departureMs = getBerlinWallClockMs(cancellation.date, cancellation.fromTime);
  if (Number.isNaN(departureMs)) return false;
  if (departureMs > nowMs - SETTLE_MS) return false;
  return (nowMs - departureMs) / MS_PER_DAY <= MAX_LOOKBACK_DAYS;
}

/** Whether a verifiable trip is worth (re-)fetching. `recheck` forces a fresh look. */
export function needsCheck(cancellation: Cancellation, recheck: boolean, nowMs: number): boolean {
  const existing = cancellation.verification;
  if (!existing || recheck) return true;
  if (!PROVISIONAL_STATUSES.has(existing.status)) return false;
  if ((existing.attempts ?? 1) >= MAX_ATTEMPTS) return false;
  return existing.checkedAt !== formatBerlinWallClock(nowMs).date;
}

/**
 * Stamp the running attempt count. This is run bookkeeping rather than part of classifying a
 * journey, which is why it lives here and not in `classifyJourney`.
 *
 * Carried **only while the verdict is provisional** — that is the sole state `needsCheck` reads it
 * in, so on a settled verdict it is a number nothing will ever consult again. Dropping it there
 * also keeps a verdict that settles from carrying the history of how long it took to get there.
 */
export function withAttemptCount(
  verification: TripVerification,
  previous: TripVerification | undefined,
): TripVerification {
  if (!PROVISIONAL_STATUSES.has(verification.status)) {
    const { attempts: _spent, ...settled } = verification;
    return settled;
  }
  const previousAttempts = previous ? (previous.attempts ?? 1) : 0;
  return { ...verification, attempts: previousAttempts + 1 };
}

/** Which verdict a run decided to store, and whether that meant discarding the fresh one. */
export interface VerdictChoice {
  /** The verdict to store, with its attempt count already stamped. */
  readonly verification: TripVerification;
  /** True when the fresh verdict was discarded as weaker and the stored one kept. */
  readonly retainedPrevious: boolean;
}

/**
 * Pick which of two verdicts to store. **Evidence only ratchets up.**
 *
 * bahn.expert thins realtime detail out of a journey as the day recedes: stops that carried
 * observations lose them, and the same trip re-reads as less and less served. Measured on
 * 2026-08-13, a same-day recheck the following morning turned four `ran` verdicts into `no-data`
 * or `partial` and five `partial` into `cancelled` — every single change in the direction of less
 * evidence, none the other way. Left unguarded, each recheck would quietly rewrite correct
 * verdicts into confident-looking wrong ones, and `cancelled` is exactly the verdict that decay
 * manufactures.
 *
 * Explicit cancellation flags are compared first and tracking second. Adding cancellation flags
 * always wins even if ordinary realtime has meanwhile decayed; removing them never silently
 * erases the stronger stored evidence. With equal cancellation evidence, a loss of tracked stops
 * is discarded. A changed non-zero segment denominator is treated as a new scope and accepted:
 * stop matching or the published route changed, so comparing raw counts across the two segments
 * would preserve a confidently wrong boundary. Conversely, an unresolved lookup (zero stops)
 * cannot erase an already located segment.
 *
 * The attempt count is bumped either way: the trip *was* looked up, and without that a permanently
 * decaying trip would be re-asked on every run forever.
 */
export function retainStrongerVerdict(
  previous: TripVerification | undefined,
  fresh: TripVerification,
): VerdictChoice {
  if (!previous) {
    return { verification: withAttemptCount(fresh, undefined), retainedPrevious: false };
  }

  const previousMethodVersion = previous.methodVersion ?? 1;
  if (fresh.methodVersion > previousMethodVersion) {
    // A newer matcher positively rejecting fetched journey details corrects an old false match.
    // Merely finding no journey can also mean the short-lived feed has already decayed, so it
    // must not erase a previously located segment.
    if (
      previous.segmentStops > 0 &&
      fresh.status === 'unresolved' &&
      fresh.unresolvedReason !== 'journey-mismatch'
    ) {
      return { verification: withAttemptCount(previous, previous), retainedPrevious: true };
    }
    return { verification: withAttemptCount(fresh, previous), retainedPrevious: false };
  }

  const lostResolvedJourney = previous.segmentStops > 0 && fresh.segmentStops === 0;
  const scopeChanged =
    previous.segmentStops > 0 &&
    fresh.segmentStops > 0 &&
    previous.segmentStops !== fresh.segmentStops;
  const lostCancellationEvidence =
    (previous.journeyCancelled === true && fresh.journeyCancelled !== true) ||
    (fresh.journeyCancelled !== true &&
      fresh.segmentCancelledStops < previous.segmentCancelledStops);
  const lostTrackingEvidence =
    fresh.segmentCancelledStops === previous.segmentCancelledStops &&
    fresh.segmentTrackedStops < previous.segmentTrackedStops;
  const retainPrevious =
    lostResolvedJourney || (!scopeChanged && (lostCancellationEvidence || lostTrackingEvidence));

  return retainPrevious
    ? { verification: withAttemptCount(previous, previous), retainedPrevious: true }
    : { verification: withAttemptCount(fresh, previous), retainedPrevious: false };
}
