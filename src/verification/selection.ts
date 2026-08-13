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
 */
export function withAttemptCount(
  verification: TripVerification,
  previous: TripVerification | undefined,
): TripVerification {
  return { ...verification, attempts: (previous?.attempts ?? 0) + 1 };
}
