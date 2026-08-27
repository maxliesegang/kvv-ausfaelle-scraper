import type { Cancellation } from '../types.js';
import { getBerlinWallClockMs } from '../utils/berlin-time.js';
import {
  fetchJourneyDetails,
  findJourneys,
  MAX_LOOKBACK_DAYS,
  orderJourneyCandidates,
} from './bahn-expert.js';
import type { VerificationProvider } from './provider.js';
import { isCheckable } from './selection.js';
import {
  classifyJourney,
  createJourneyMismatchVerification,
  createUnresolvedVerification,
  identifiesNetworkJourney,
  type TripVerification,
} from './verify.js';

const REQUEST_TIMEOUT_MS = 20_000;

export const BAHN_EXPERT_SOURCE = 'bahn.expert' as const;

export async function verifyWithBahnExpert(
  cancellation: Cancellation,
  now: Date,
): Promise<TripVerification> {
  const journeyNumber = Number(cancellation.trainNumber);
  if (!Number.isFinite(journeyNumber)) {
    return createUnresolvedVerification(now, 'invalid-train-number', undefined, BAHN_EXPERT_SOURCE);
  }

  const departureDate = new Date(getBerlinWallClockMs(cancellation.date, '10:00'));
  const candidates = await findJourneys(journeyNumber, departureDate, REQUEST_TIMEOUT_MS);
  if (candidates.length === 0) {
    return createUnresolvedVerification(now, 'journey-not-found', undefined, BAHN_EXPERT_SOURCE);
  }

  const ordered = orderJourneyCandidates(candidates, cancellation.line);
  let firstCandidateError: unknown;
  let networkJourneyId: string | undefined;
  let journeyMismatchEvidence: TripVerification | null = null;

  for (const candidate of ordered) {
    let details;
    try {
      const fetched = await fetchJourneyDetails(candidate.journeyId, REQUEST_TIMEOUT_MS);
      details = fetched && { ...fetched, journeyId: fetched.journeyId ?? candidate.journeyId };
    } catch (error) {
      firstCandidateError ??= error;
      continue;
    }
    if (!details) continue;
    if (identifiesNetworkJourney(cancellation, details)) {
      networkJourneyId ??= details.journeyId;
    }
    const verdict = classifyJourney(cancellation, details, now, BAHN_EXPERT_SOURCE);
    if (verdict) return verdict;
    const mismatchEvidence = createJourneyMismatchVerification(
      cancellation,
      details,
      now,
      BAHN_EXPERT_SOURCE,
    );
    if (
      mismatchEvidence &&
      (!journeyMismatchEvidence ||
        mismatchEvidence.journeyCancelledStops + mismatchEvidence.journeyTrackedStops >
          journeyMismatchEvidence.journeyCancelledStops +
            journeyMismatchEvidence.journeyTrackedStops)
    ) {
      journeyMismatchEvidence = mismatchEvidence;
    }
  }

  if (journeyMismatchEvidence) return journeyMismatchEvidence;
  if (firstCandidateError) throw firstCandidateError;
  if (networkJourneyId !== undefined) {
    return createUnresolvedVerification(
      now,
      'journey-mismatch',
      networkJourneyId,
      BAHN_EXPERT_SOURCE,
    );
  }
  return createUnresolvedVerification(
    now,
    candidates.length > 0 ? 'journey-not-in-network' : 'journey-not-found',
    undefined,
    BAHN_EXPERT_SOURCE,
  );
}

export const bahnExpertProvider: VerificationProvider = {
  source: BAHN_EXPERT_SOURCE,
  canCheck(cancellation, now) {
    return isCheckable(cancellation, now.getTime(), MAX_LOOKBACK_DAYS);
  },
  verify: verifyWithBahnExpert,
};
