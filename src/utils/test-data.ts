/**
 * Utilities for test data preparation.
 * Used by scripts that generate test fixtures.
 */

import type { Cancellation } from '../types.js';

/**
 * Normalizes cancellations for test comparison by removing dynamic fields.
 * Removes sourceUrl and capturedAt which vary between test runs.
 */
export function normalizeCancellationsForTest(
  cancellations: Cancellation[],
): Omit<Cancellation, 'sourceUrl' | 'capturedAt'>[] {
  return cancellations.map(({ sourceUrl, capturedAt, ...rest }) => rest);
}
