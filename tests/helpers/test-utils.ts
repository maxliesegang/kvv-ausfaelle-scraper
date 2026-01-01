/**
 * Shared test utilities for all test files.
 * Provides common helpers for normalization, comparison, and assertions.
 */

import type { Cancellation } from '../../src/types.js';
import assert from 'node:assert';

/**
 * Normalizes a cancellation object for test comparison by removing dynamic fields.
 * Removes sourceUrl and capturedAt which vary between test runs.
 */
export function normalizeCancellation(
  cancellation: Cancellation,
): Omit<Cancellation, 'sourceUrl' | 'capturedAt'> {
  const { sourceUrl, capturedAt, ...rest } = cancellation;
  return rest;
}

/**
 * Normalizes an array of cancellations for test comparison.
 */
export function normalizeCancellations(
  cancellations: Cancellation[],
): Omit<Cancellation, 'sourceUrl' | 'capturedAt'>[] {
  return cancellations.map(normalizeCancellation);
}

/**
 * Deep comparison of cancellation objects with detailed error messages.
 */
export function assertCancellationsEqual(
  actual: Cancellation[],
  expected: Partial<Cancellation>[],
  message?: string,
): void {
  const prefix = message ? `${message}: ` : '';

  // Check count
  assert.strictEqual(
    actual.length,
    expected.length,
    `${prefix}Expected ${expected.length} cancellations, got ${actual.length}`,
  );

  // Compare each cancellation
  for (let i = 0; i < expected.length; i++) {
    const actualNormalized = normalizeCancellation(actual[i]!);
    const expectedItem = expected[i]!;

    for (const [key, expectedValue] of Object.entries(expectedItem)) {
      const actualValue = actualNormalized[key as keyof typeof actualNormalized];
      assert.deepStrictEqual(
        actualValue,
        expectedValue,
        `${prefix}Cancellation ${i}: ${key} mismatch`,
      );
    }
  }
}

/**
 * Asserts that a function throws an error matching a pattern.
 */
export function assertThrows(
  fn: () => void,
  errorPattern: string | RegExp,
  message?: string,
): void {
  try {
    fn();
    assert.fail(message || `Expected function to throw an error matching: ${errorPattern}`);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    if (typeof errorPattern === 'string') {
      assert.ok(
        errorMessage.includes(errorPattern),
        `${message || 'Error message'} should include "${errorPattern}". Got: "${errorMessage}"`,
      );
    } else {
      assert.match(errorMessage, errorPattern, message);
    }
  }
}

/**
 * Asserts that an array is sorted according to a comparator.
 */
export function assertSorted<T>(
  array: T[],
  comparator: (a: T, b: T) => number,
  message?: string,
): void {
  for (let i = 0; i < array.length - 1; i++) {
    const current = array[i]!;
    const next = array[i + 1]!;

    assert.ok(
      comparator(current, next) <= 0,
      `${message || 'Array not sorted'}: ${current} > ${next} at index ${i}`,
    );
  }
}

/**
 * Numeric comparator for sorting strings as numbers.
 */
export function numericStringComparator(a: string, b: string): number {
  return parseInt(a, 10) - parseInt(b, 10);
}
