/**
 * Regex patterns and text markers for parsing cancellation detail pages.
 */

/**
 * Regex patterns for parsing cancellation detail pages.
 */
export const PATTERNS = {
  /**
   * Matches "Linie <line>" to extract the transit line identifier.
   * Requires the token to contain at least one digit to avoid words like "Regiobus".
   */
  LINE: /Linien?\s+([A-Za-z]+[0-9][A-Za-z0-9-]*)/i,

  /** Matches "Nach aktuellem Stand DD.MM.YYYY HH:MM:SS" to extract the status timestamp */
  STAND: /Nach aktuellem Stand\s+(\d{2}\.\d{2}\.\d{4})\s+(\d{2}:\d{2}:\d{2})/,

  /** Matches "DD.MM.YYYY, HH:MM Uhr" alternative date format (without seconds) */
  STAND_ALT: /(\d{2}\.\d{2}\.\d{4}),\s*(\d{2}:\d{2})\s*Uhr/,

  /**
   * Matches trip format: <trainNumber> <fromStop> (<time>) - <toStop> (<time>)
   * Handles optional "Uhr" suffix after times
   * Example: "123 Karlsruhe Hbf (10:30 Uhr) - Bruchsal (11:00)"
   */
  TRIP_OLD_FORMAT:
    /^(\d+)\s+(.+?)\s+\((\d{1,2}:\d{2})(?:\s*Uhr)?\)\s*[-–]+\s*(.+?)\s+\((\d{1,2}:\d{2})(?:\s*Uhr)?\)/,

  /**
   * Matches trip format: <trainNumber> <time> Uhr <fromStop> - <time> Uhr <toStop>
   * Example: "84888 08:38 Uhr Söllingen Bahnhof - 10:07 Uhr Germersheim Bahnhof"
   */
  TRIP_NEW_FORMAT:
    /^(\d+)\s+(\d{1,2}:\d{2})(?:\s*Uhr)?\s+(.+?)\s*[-–]+\s*(\d{1,2}:\d{2})(?:\s*Uhr)?\s+(.+)/,
} as const;

/**
 * Text markers used to identify sections in the HTML.
 */
export const MARKERS = {
  /** Markers that precede the list of affected trips (multiple variants) */
  TRIPS_START: [
    'sind folgende Fahrten von einem (Teil-)Ausfall betroffen:',
    'sind folgende Fahrten betroffen:',
    'Betroffene Fahrten:',
  ] as readonly string[],

  /** Marker that ends the list of affected trips */
  TRIPS_END: 'Ob deine Verbindung' as const,
};

/** Default line value when parsing fails */
export const DEFAULT_LINE = 'UNKNOWN' as const;

/**
 * Pattern that detects potential multi-line mentions.
 * Matches: "und" (and), commas, slashes, ampersands.
 */
export const MULTI_LINE_HINT_PATTERN = /\bund\b|,|\/|&/i;

/**
 * Pattern that detects line ranges.
 * Example: "S1-S11" or "S1 - S11"
 */
export const MULTI_LINE_RANGE_PATTERN = /[A-Za-z]+\d+\s*-\s*[A-Za-z]*\d+/;

/**
 * Pattern to extract line mention sections.
 * Matches: "Linie S1" or "Linien S1, S2" followed by text until period or newline.
 */
export const LINE_MENTION_SECTION_PATTERN = /Linien?\s+([^.\n]+)/gi;

/**
 * Pattern to extract individual line identifiers.
 * Matches: Letter(s) followed by 1-3 digits (e.g., S1, S11, STR1).
 */
export const LINE_IDENTIFIER_PATTERN = /\b[A-Za-z]+\d{1,3}\b/g;
