/**
 * Which stored trips a verification run should look at, and when to stop looking.
 *
 * Kept apart from `./verify.ts`: that module decides *what happened* to a trip, this one decides
 * *whether to ask*. Both are pure, so the run script stays orchestration only.
 */

import type { Cancellation } from '../types.js';
import { getBerlinWallClockMs } from '../utils/berlin-time.js';
import { MAX_LOOKBACK_DAYS } from './bahn-expert.js';
import type { TripVerification } from './verify.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Grace period after departure before a trip is judged, so a running trip is not called missing. */
export const SETTLE_MS = 30 * 60 * 1000;

/**
 * Provisional verdicts are retried on later runs — realtime data can arrive late — but only a few
 * times. Some trips never resolve at all (KVV occasionally publishes a train number on a line no
 * feed knows), and without a bound those would be looked up on every run for the whole six-day
 * window only to produce the same answer.
 */
export const MAX_ATTEMPTS = 3;

/** Verdicts that may still change, and so are worth asking about again. */
const PROVISIONAL_STATUSES = new Set<TripVerification['status']>(['no-data', 'unresolved']);

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
export function needsCheck(cancellation: Cancellation, recheck: boolean): boolean {
  const existing = cancellation.verification;
  if (!existing || recheck) return true;
  if (!PROVISIONAL_STATUSES.has(existing.status)) return false;
  return (existing.attempts ?? 1) < MAX_ATTEMPTS;
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
  return { ...verification, attempts: (previous?.attempts ?? 0) + 1 };
}

/**
 * Stops the feed made a positive statement about — either "this stop was cancelled" or "the
 * vehicle was observed here". Silence counts for nothing, which is the whole point: it is the
 * quantity that decays as a day recedes.
 *
 * A stop can be both cancelled and tracked, so this over-counts slightly; it is a monotone proxy
 * for how much the feed knew, not a stop count to publish.
 */
function countEvidenceStops(verification: TripVerification): number {
  return verification.segmentCancelledStops + verification.segmentTrackedStops;
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
 * So a fresh verdict backed by *fewer* observed stops than the stored one is discarded and the
 * stored verdict kept. Genuine late-arriving realtime moves the other way — it adds cancellation
 * flags or observations — and still wins, which is what makes retrying `no-data` worth doing at
 * all. The attempt count is bumped either way: the trip *was* looked up, and without that a
 * permanently decaying trip would be re-asked on every run forever.
 */
export function retainStrongerVerdict(
  previous: TripVerification | undefined,
  fresh: TripVerification,
): VerdictChoice {
  if (previous && countEvidenceStops(fresh) < countEvidenceStops(previous)) {
    return { verification: withAttemptCount(previous, previous), retainedPrevious: true };
  }
  return { verification: withAttemptCount(fresh, previous), retainedPrevious: false };
}
