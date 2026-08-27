import type { Cancellation } from '../types.js';
import { getBerlinWallClockMs } from '../utils/berlin-time.js';
import type { VerificationProvider } from './provider.js';
import { isCheckable } from './selection.js';
import { fetchTransitousTrip, findTransitousTrips, mapTransitousJourney } from './transitous.js';
import {
  classifyJourney,
  createJourneyMismatchVerification,
  createUnresolvedVerification,
  type TripVerification,
} from './verify.js';

const REQUEST_TIMEOUT_MS = 20_000;
/** Transitous publishes a live normalized timetable, not a historical realtime contract. */
export const TRANSITOUS_MAX_LOOKBACK_DAYS = 1;
export const TRANSITOUS_SOURCE = 'transitous' as const;

export function keepOnlyStrongTransitousClaims(verification: TripVerification): TripVerification {
  const inferredCancellation =
    verification.status === 'cancelled' &&
    verification.journeyCancelled !== true &&
    verification.segmentCancelledStops === 0;
  // Transitous has no per-stop observed flag. Varying timestamps can safely prove that a vehicle
  // ran, but silence inside that data is not strong enough to infer a cancellation here. Accept
  // cancellation only when MOTIS itself supplied a trip/stop flag.
  return inferredCancellation ? { ...verification, status: 'no-data' } : verification;
}

export async function verifyWithTransitous(
  cancellation: Cancellation,
  now: Date,
): Promise<TripVerification> {
  const journeyNumber = Number(cancellation.trainNumber);
  if (!Number.isFinite(journeyNumber)) {
    return createUnresolvedVerification(now, 'invalid-train-number', undefined, TRANSITOUS_SOURCE);
  }

  const departureInstant = new Date(getBerlinWallClockMs(cancellation.date, cancellation.fromTime));
  const candidates = await findTransitousTrips(cancellation, departureInstant, REQUEST_TIMEOUT_MS);
  if (candidates.length === 0) {
    return createUnresolvedVerification(now, 'journey-not-found', undefined, TRANSITOUS_SOURCE);
  }

  let mismatchEvidence: TripVerification | null = null;
  let firstCandidateError: unknown;
  for (const candidate of candidates) {
    let itinerary;
    try {
      itinerary = await fetchTransitousTrip(candidate.tripId, REQUEST_TIMEOUT_MS);
    } catch (error) {
      firstCandidateError ??= error;
      continue;
    }
    const details = mapTransitousJourney(itinerary, candidate);
    if (!details) continue;
    const verdict = classifyJourney(cancellation, details, now, TRANSITOUS_SOURCE);
    if (verdict) return keepOnlyStrongTransitousClaims(verdict);
    mismatchEvidence ??= createJourneyMismatchVerification(
      cancellation,
      details,
      now,
      TRANSITOUS_SOURCE,
    );
  }

  if (!mismatchEvidence && firstCandidateError) throw firstCandidateError;

  return (
    mismatchEvidence ??
    createUnresolvedVerification(now, 'journey-mismatch', candidates[0]?.tripId, TRANSITOUS_SOURCE)
  );
}

export const transitousProvider: VerificationProvider = {
  source: TRANSITOUS_SOURCE,
  canCheck(cancellation, now) {
    return isCheckable(cancellation, now.getTime(), TRANSITOUS_MAX_LOOKBACK_DAYS);
  },
  verify: verifyWithTransitous,
};
