import type { Cancellation } from '../types.js';
import type { TripVerification, VerificationSource } from './verify.js';

/** One independently queried realtime source. */
export interface VerificationProvider {
  readonly source: VerificationSource;
  /** Whether this provider can still answer after the announced segment has settled. */
  canCheck(cancellation: Cancellation, now: Date): boolean;
  /** Produce source-specific evidence; transport failures throw and are never persisted. */
  verify(cancellation: Cancellation, now: Date): Promise<TripVerification>;
}

export interface ProviderFailure {
  readonly source: VerificationSource;
  readonly error: unknown;
}

export interface ProviderCheckResult {
  readonly verifications: readonly TripVerification[];
  readonly attemptedSources: readonly VerificationSource[];
  readonly failures: readonly ProviderFailure[];
}

/** A source result that can settle a trip without asking a fallback provider. */
export function isConclusiveVerification(verification: TripVerification): boolean {
  return verification.status === 'cancelled' || verification.status === 'ran';
}

/**
 * Query providers in priority order. A provisional answer permits the next provider to add
 * evidence; a conclusive answer stops the chain so the fallback is not needlessly loaded.
 * Provider failures are returned as data because verification is advisory and best-effort.
 */
export async function verifyWithProviders(
  cancellation: Cancellation,
  now: Date,
  providers: readonly VerificationProvider[],
): Promise<ProviderCheckResult> {
  const verifications: TripVerification[] = [];
  const attemptedSources: VerificationSource[] = [];
  const failures: ProviderFailure[] = [];

  for (const provider of providers) {
    if (!provider.canCheck(cancellation, now)) continue;
    attemptedSources.push(provider.source);
    try {
      const verification = await provider.verify(cancellation, now);
      verifications.push(verification);
      if (isConclusiveVerification(verification)) break;
    } catch (error) {
      failures.push({ source: provider.source, error });
    }
  }

  return { verifications, attemptedSources, failures };
}
