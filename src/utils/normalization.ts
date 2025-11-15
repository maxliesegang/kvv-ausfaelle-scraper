/**
 * Shared string normalization utilities to ensure consistent data handling.
 */

/**
 * Normalizes a line identifier by trimming whitespace.
 * Returns undefined if the input is empty or only whitespace.
 */
export function normalizeLine(line: string | undefined | null): string | undefined {
  const trimmed = line?.trim();
  return trimmed || undefined;
}

/**
 * Normalizes a train number by trimming whitespace.
 * Returns undefined if the input is empty or only whitespace.
 */
export function normalizeTrainNumber(trainNumber: string | undefined | null): string | undefined {
  const trimmed = trainNumber?.trim();
  return trimmed || undefined;
}

/**
 * Normalizes and uppercases a line identifier.
 * Returns undefined if the input is empty or only whitespace.
 */
export function normalizeLineUppercase(line: string | undefined | null): string | undefined {
  const trimmed = line?.trim();
  return trimmed ? trimmed.toUpperCase() : undefined;
}

/**
 * Normalizes an array of line identifiers by trimming and uppercasing.
 * Filters out empty or whitespace-only values.
 */
export function normalizeLines(lines: readonly (string | undefined | null)[]): string[] {
  return lines
    .map((line) => normalizeLineUppercase(line))
    .filter((line): line is string => Boolean(line));
}
