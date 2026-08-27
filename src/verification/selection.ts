/**
 * Which stored trips a verification run should look at, and when to stop looking.
 *
 * Kept apart from `./verify.ts`: that module decides *what happened* to a trip, this one decides
 * *whether to ask*. Both are pure, so the run script stays orchestration only.
 */

import type { Cancellation } from '../types.js';
import { formatBerlinWallClock, getBerlinWallClockMs } from '../utils/berlin-time.js';
import { MAX_LOOKBACK_DAYS } from './bahn-expert.js';
import {
  VERIFICATION_METHOD_VERSION,
  type TripVerification,
  type VerificationAgreement,
  type VerificationEvidence,
  type VerificationSource,
} from './verify.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Grace period after the announced segment ends, so a running trip is not judged prematurely. */
export const SETTLE_MS = 30 * 60 * 1000;

function nextDate(date: string): string {
  const noonUtc = new Date(`${date}T12:00:00.000Z`);
  noonUtc.setUTCDate(noonUtc.getUTCDate() + 1);
  return noonUtc.toISOString().slice(0, 10);
}

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
 * Whether a trip can be checked at all: its announced segment has ended (plus a settling grace
 * period) and its departure is still inside the feed's lookback window. Waiting for the segment
 * end matters on long runs: checking 30 minutes after departure can see only the first observed
 * stops and permanently settle a false partial or inferred-cancellation verdict.
 *
 * Trips older than the window are permanently unverifiable.
 */
export function isSegmentSettled(cancellation: Cancellation, nowMs: number): boolean {
  const departureMs = getBerlinWallClockMs(cancellation.date, cancellation.fromTime);
  if (Number.isNaN(departureMs)) return false;
  const sameDayEndMs = getBerlinWallClockMs(cancellation.date, cancellation.toTime);
  if (Number.isNaN(sameDayEndMs)) return false;
  const endDate = sameDayEndMs < departureMs ? nextDate(cancellation.date) : cancellation.date;
  const segmentEndMs = getBerlinWallClockMs(endDate, cancellation.toTime);
  return !Number.isNaN(segmentEndMs) && segmentEndMs <= nowMs - SETTLE_MS;
}

/** Whether the departure is still inside one provider's measured/declared retention window. */
export function isWithinLookback(
  cancellation: Cancellation,
  nowMs: number,
  maxLookbackDays: number,
): boolean {
  const departureMs = getBerlinWallClockMs(cancellation.date, cancellation.fromTime);
  if (Number.isNaN(departureMs) || departureMs > nowMs) return false;
  return (nowMs - departureMs) / MS_PER_DAY <= maxLookbackDays;
}

/** Whether a provider can still answer for this trip at the given instant. */
export function isCheckable(
  cancellation: Cancellation,
  nowMs: number,
  maxLookbackDays: number,
): boolean {
  return (
    isSegmentSettled(cancellation, nowMs) && isWithinLookback(cancellation, nowMs, maxLookbackDays)
  );
}

export function isVerifiable(cancellation: Cancellation, nowMs: number): boolean {
  return isCheckable(cancellation, nowMs, MAX_LOOKBACK_DAYS);
}

/** Whether a verifiable trip is worth (re-)fetching. `recheck` forces a fresh look. */
export function needsCheck(cancellation: Cancellation, recheck: boolean, nowMs: number): boolean {
  const existing = cancellation.verification;
  if (!existing || recheck) return true;
  // Matching fixes must reach records whose ordinary retry budget is already exhausted. Once the
  // new verdict is written its version is current and this path naturally switches itself off.
  if ((existing.methodVersion ?? 1) < VERIFICATION_METHOD_VERSION) return true;
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
  verification: VerificationEvidence,
  previous: VerificationEvidence | undefined,
): VerificationEvidence {
  if (!PROVISIONAL_STATUSES.has(verification.status)) {
    const { attempts: _spent, ...settled } = verification;
    return settled;
  }
  const previousAttempts = previous ? (previous.attempts ?? 1) : 0;
  return { ...verification, attempts: previousAttempts + 1 };
}

/** Which verdict a run decided to store, and whether that meant discarding the fresh one. */
export interface VerdictChoice<T extends VerificationEvidence = VerificationEvidence> {
  /** The verdict to store, with its attempt count already stamped. */
  readonly verification: T;
  /** True when the fresh verdict was discarded as weaker and the stored one kept. */
  readonly retainedPrevious: boolean;
}

function sourceEvidence(verification: TripVerification): VerificationEvidence {
  const { checks: _checks, agreement: _agreement, ...evidence } = verification;
  return evidence;
}

function evidenceRank(verification: VerificationEvidence): number {
  if (
    verification.journeyCancelled ||
    (verification.status === 'cancelled' && verification.segmentCancelledStops > 0)
  ) {
    return 7;
  }
  if (verification.segmentCancelledStops > 0) return 6;
  if (verification.status === 'cancelled') return 5;
  if (verification.status === 'ran') return 4;
  if (verification.status === 'partial') return 3;
  if (verification.status === 'no-data') return 2;
  return 1;
}

function agreementFor(
  checks: Partial<Record<VerificationSource, VerificationEvidence>>,
): VerificationAgreement {
  const evidence = Object.values(checks).filter(
    (check): check is VerificationEvidence => check !== undefined,
  );
  const settled = evidence
    .map((check) => check?.status)
    .filter((status) => status === 'cancelled' || status === 'ran');
  const hasCancellationEvidence = evidence.some(
    (check) =>
      check.status === 'cancelled' ||
      check.journeyCancelled === true ||
      check.segmentCancelledStops > 0,
  );
  if (hasCancellationEvidence && settled.includes('ran')) return 'conflicting';
  if (settled.length >= 2 && new Set(settled).size === 1) return 'corroborated';
  return 'single-source';
}

const SOURCE_PRIORITY: Readonly<Record<VerificationSource, number>> = {
  'bahn.expert': 0,
  transitous: 1,
};

/**
 * Merge independently sourced results without comparing their raw stop counts as if they came
 * from one feed. Each source first passes through its own decay ratchet; selection then uses only
 * semantic evidence strength, with source priority as the final tie-breaker.
 */
export function selectAcrossSources(
  previous: TripVerification | undefined,
  fresh: readonly TripVerification[],
): VerdictChoice<TripVerification> {
  const checks: Partial<Record<VerificationSource, VerificationEvidence>> = {
    ...(previous?.checks ?? {}),
  };
  if (previous) checks[previous.source] = sourceEvidence(previous);

  const retainedBySource = new Set<VerificationSource>();
  for (const result of fresh) {
    const prior = checks[result.source];
    const choice = retainStrongerVerdict(prior, result);
    checks[result.source] = choice.verification;
    if (choice.retainedPrevious) retainedBySource.add(result.source);
  }

  const available = Object.values(checks).filter(
    (value): value is VerificationEvidence => value !== undefined,
  );
  if (available.length === 0) {
    throw new Error('selectAcrossSources requires previous or fresh verification evidence');
  }
  available.sort(
    (a, b) =>
      evidenceRank(b) - evidenceRank(a) || SOURCE_PRIORITY[a.source] - SOURCE_PRIORITY[b.source],
  );
  const selected = available[0]!;
  const verification: TripVerification =
    available.length === 1
      ? { ...selected }
      : { ...selected, checks, agreement: agreementFor(checks) };
  return {
    verification,
    retainedPrevious: retainedBySource.has(selected.source),
  };
}

/** Keep the evidence but record that it was assessed again by the fresh check. */
function retainPreviousEvidence(
  previous: VerificationEvidence,
  fresh: VerificationEvidence,
): VerificationEvidence {
  const retained = {
    ...previous,
    // Without refreshing this date, the next workflow run on the same day retries immediately and
    // can spend the entire bounded attempt budget before any new realtime has had time to arrive.
    checkedAt: fresh.checkedAt,
    // A newer matcher that found the same journey but less expiring evidence has still validated
    // the stored match. Stamp the current version so migration does not repeat on every run.
    methodVersion: Math.max(previous.methodVersion ?? 1, fresh.methodVersion),
  };
  return withAttemptCount(retained, previous);
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
  previous: VerificationEvidence | undefined,
  fresh: VerificationEvidence,
): VerdictChoice {
  if (!previous) {
    return { verification: withAttemptCount(fresh, undefined), retainedPrevious: false };
  }

  const previousMethodVersion = previous.methodVersion ?? 1;
  const methodUpgraded = fresh.methodVersion > previousMethodVersion;
  if (
    methodUpgraded &&
    fresh.status === 'unresolved' &&
    fresh.unresolvedReason === 'journey-mismatch'
  ) {
    // A newer matcher positively rejecting fetched journey details corrects an old false match.
    // Other newer-method results still pass through the evidence ratchet below: method migration
    // must not turn feed decay into a confident downgrade.
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
  // Tracking is this classifier's own inference from the feed's timestamps, so a newer method is
  // entitled to revise it downwards — that is what version 7 does when it stops reading a
  // propagated delay forecast as observation, and without this the ratchet would preserve exactly
  // the `ran` verdicts that change exists to withdraw. Cancellation flags are not revised this
  // way: those are the feed's own statements, and they keep ratcheting up across versions.
  const lostTrackingEvidence =
    !methodUpgraded &&
    fresh.segmentCancelledStops === previous.segmentCancelledStops &&
    fresh.segmentTrackedStops < previous.segmentTrackedStops;
  const bothSegmentsUnresolved = previous.segmentStops === 0 && fresh.segmentStops === 0;
  const journeyScopeChanged =
    previous.journeyStops > 0 &&
    fresh.journeyStops > 0 &&
    previous.journeyStops !== fresh.journeyStops;
  const lostJourneyCancellationEvidence =
    (previous.journeyCancelled === true && fresh.journeyCancelled !== true) ||
    (fresh.journeyCancelled !== true &&
      fresh.journeyCancelledStops < previous.journeyCancelledStops);
  const lostJourneyTrackingEvidence =
    !methodUpgraded &&
    fresh.journeyCancelledStops === previous.journeyCancelledStops &&
    fresh.journeyTrackedStops < previous.journeyTrackedStops;
  const retainPrevious =
    lostResolvedJourney ||
    (!scopeChanged && (lostCancellationEvidence || lostTrackingEvidence)) ||
    (bothSegmentsUnresolved &&
      !journeyScopeChanged &&
      (lostJourneyCancellationEvidence || lostJourneyTrackingEvidence));

  return retainPrevious
    ? { verification: retainPreviousEvidence(previous, fresh), retainedPrevious: true }
    : { verification: withAttemptCount(fresh, previous), retainedPrevious: false };
}
