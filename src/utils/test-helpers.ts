/**
 * Utilities for test data preparation and normalization.
 */

import type { Cancellation } from '../types.js';

/**
 * Normalizes a cancellation object for test comparison by removing dynamic fields.
 * Removes sourceUrl and capturedAt which vary between test runs.
 */
export function normalizeCancellationForTest(
  cancellation: Cancellation,
): Omit<Cancellation, 'sourceUrl' | 'capturedAt'> {
  const { sourceUrl, capturedAt, ...rest } = cancellation;
  return rest;
}

/**
 * Normalizes an array of cancellations for test comparison.
 */
export function normalizeCancellationsForTest(
  cancellations: Cancellation[],
): Omit<Cancellation, 'sourceUrl' | 'capturedAt'>[] {
  return cancellations.map(normalizeCancellationForTest);
}
