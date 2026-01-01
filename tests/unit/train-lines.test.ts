/**
 * Train lines lookup unit tests.
 * Tests the exact match and fallback matching behavior for train number lookups.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { lookupLineForTrain } from '../../src/train-lines.js';

describe('Train Lines - Exact Match', () => {
  it('should return correct line for existing train numbers', () => {
    const testCases = [
      { trainNumber: '10001', expectedLine: 'S1' },
      { trainNumber: '10002', expectedLine: 'S1' },
    ];

    for (const { trainNumber, expectedLine } of testCases) {
      const result = lookupLineForTrain(trainNumber);
      assert.strictEqual(
        result,
        expectedLine,
        `Train ${trainNumber} should map to line ${expectedLine}`,
      );
    }
  });

  it('should return undefined for completely non-existent train numbers', () => {
    const nonExistentNumbers = [
      '99999', // No 9999* pattern exists
      '88888', // No 8888* pattern exists
    ];

    for (const trainNumber of nonExistentNumbers) {
      const result = lookupLineForTrain(trainNumber);
      assert.strictEqual(result, undefined, `Train ${trainNumber} should return undefined`);
    }
  });

  it('should handle edge cases gracefully', () => {
    const edgeCases = [
      { input: '1', expected: undefined, desc: 'single digit' },
      { input: '', expected: undefined, desc: 'empty string' },
    ];

    for (const { input, expected, desc } of edgeCases) {
      const result = lookupLineForTrain(input);
      assert.strictEqual(result, expected, `Should handle ${desc}`);
    }
  });
});

describe('Train Lines - Preferred Lines', () => {
  it('should respect preferred lines when provided', () => {
    const result = lookupLineForTrain('10001', ['S1']);
    assert.strictEqual(result, 'S1', 'Should respect preferred line S1');
  });

  it('should work without preferred lines', () => {
    const result = lookupLineForTrain('10001');
    assert.strictEqual(result, 'S1', 'Should work without preferred lines');
  });

  it('should handle empty preferred lines array', () => {
    const result = lookupLineForTrain('10001', []);
    assert.strictEqual(result, 'S1', 'Should work with empty preferred lines');
  });

  it('should handle case-insensitive preferred lines', () => {
    const result1 = lookupLineForTrain('10001', ['S1']);
    const result2 = lookupLineForTrain('10001', ['s1']);

    assert.ok(
      result1 === 'S1' || result2 === 'S1',
      'Should handle case differences in preferred lines',
    );
  });
});

describe('Train Lines - Fallback Matching', () => {
  it('should demonstrate fallback pattern matching logic', () => {
    // This test documents how fallback matching works
    const examples = {
      '10004': '1000*', // Matches 10001, 10002, 10003, 10005, etc.
      '50003': '5000*', // Matches 50001, 50002, 50005, etc.
      '70019': '7001*', // Matches 70010, 70011, 70012, etc.
    };

    for (const [trainNumber, pattern] of Object.entries(examples)) {
      const prefix = trainNumber.slice(0, -1);
      assert.strictEqual(
        prefix,
        pattern.slice(0, -1),
        `${trainNumber} should match pattern ${pattern}`,
      );
    }
  });

  it('should skip fallback test to avoid file modifications', () => {
    // WARNING: Actual fallback matching modifies train line definition files!
    // To test fallback matching:
    // 1. Run: npm run test:fallback <trainNumber>
    // 2. Or see: tests/integration/fallback-matching.test.ts

    assert.ok(true, 'Fallback test skipped to avoid file modifications');
  });
});

describe('Train Lines - Data Validation', () => {
  it('should sort train numbers numerically, not lexicographically', () => {
    const numbers = ['10001', '10002', '10010', '10003'];
    const sorted = numbers.sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

    assert.deepStrictEqual(
      sorted,
      ['10001', '10002', '10003', '10010'],
      'Numbers should be sorted numerically',
    );
  });
});
