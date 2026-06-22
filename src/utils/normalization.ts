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

/**
 * Normalizes German free text for keyword matching.
 *
 * Umlauts are expanded to their ASCII digraphs (ä→ae, ö→oe, ü→ue, ß→ss) BEFORE
 * Unicode decomposition, so that keyword lists written as `ae/oe/ue` match the
 * original umlaut spelling. Any remaining diacritics are stripped, non-alphanumeric
 * characters become spaces, and whitespace is collapsed. The result is lowercase.
 *
 * This expansion is essential: without it, NFD decomposition turns `ä` into `a`,
 * so a keyword like `entfaellt` would never match the source word `entfällt`.
 */
const GERMAN_CHAR_EXPANSIONS: Readonly<Record<string, string>> = {
  ä: 'ae',
  ö: 'oe',
  ü: 'ue',
  ß: 'ss',
};

export function normalizeGermanText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[äöüß]/g, (char) => GERMAN_CHAR_EXPANSIONS[char] ?? char)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
