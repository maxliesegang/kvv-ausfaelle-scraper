/**
 * Regex patterns and text markers for parsing cancellation detail pages.
 */

/**
 * Regex patterns for parsing cancellation detail pages.
 */
export const PATTERNS = {
  /**
   * Matches "Linie <line>" and the labelled variants "Linie: <line>" / "Linie(n):
   * <line>". Requires the token to contain at least one digit to avoid words like
   * "Regiobus".
   */
  LINE: /Linien?(?:\(n\))?(?:\s*:\s*|\s+)([A-Za-z]+[0-9][A-Za-z0-9-]*)/i,

  /** Matches "Nach aktuellem Stand DD.MM.YYYY HH:MM:SS" to extract the status timestamp */
  STAND: /Nach aktuellem Stand\s+(\d{2}\.\d{2}\.\d{4})\s+(\d{2}:\d{2}:\d{2})/,

  /** Matches "DD.MM.YYYY, HH:MM Uhr" alternative date format (without seconds) */
  STAND_ALT: /(\d{2}\.\d{2}\.\d{4}),\s*(\d{2}:\d{2})\s*Uhr/,

  /**
   * Matches trip format: <trainNumber> <fromStop> (<time>) - <toStop> (<time>)
   * Handles optional "Uhr" suffix after times
   * Example: "123 Karlsruhe Hbf (10:30 Uhr) - Bruchsal (11:00)"
   */
  TRIP_STOP_TIME_REQUIRED_PARENTHESES_FORMAT:
    /^(\d+)\s+(.+?)\s+\(\s*(\d{1,2}:\d{2})\s*(?:Uhr)?\s*\)\s*[-–]+\s*(.+?)\s+\(\s*(\d{1,2}:\d{2})\s*(?:Uhr)?\s*\)/i,

  /**
   * Matches trip format: <trainNumber> <fromStop> <fromTime> Uhr - <toStop> <toTime> Uhr
   * Example: "85582 Albtalbahnhof 18:24 Uhr - Tullastraße 18:44 Uhr"
   */
  TRIP_STOP_TIME_FORMAT:
    /^(\d+)\s+(.+?)\s+(\d{1,2}:\d{2})(?:\s*Uhr)?\s*[-–]+\s*(.+?)\s+(\d{1,2}:\d{2})(?:\s*Uhr)?$/i,

  /**
   * Matches trip format using "bis" as the separator, with optional "ab"/"an" time markers:
   * <trainNumber> <fromStop> [ab] <fromTime> Uhr bis <toStop> [an] <toTime> Uhr
   * Examples: "85715 Heilbronn Hbf. Vorplatz ab 10:16 Uhr bis Mosbach Bf. an 11:16 Uhr"
   *           "84728 Berghausen Bf 11:05 Uhr bis Ka. Rheinbergstraße 11:44 Uhr"
   * Both markers are optional and independent — KVV writes the bare "bis" variant without
   * them. A trailing parenthesized annotation (e.g. "(LT)" for Linientaxi) is tolerated.
   */
  TRIP_AB_BIS_FORMAT:
    /^(\d+)\s+(.+?)\s+(?:ab\s+)?(\d{1,2}:\d{2})(?:\s*Uhr)?\s+bis\s+(.+?)\s+(?:an\s+)?(\d{1,2}:\d{2})(?:\s*Uhr)?\s*(?:\([^)]*\))?\s*$/i,

  /**
   * Matches the prose "entfällt zwischen" form KVV sometimes uses instead of a tabular row:
   * <trainNumber> entfällt zwischen <fromStop> (<fromTime> Uhr) und <toStop> (<toTime> Uhr).
   * Example: "84892 entfällt zwischen Karlsruhe Tullastraße (10:01 Uhr) und Karlsruhe
   * Rheinbergstraße (10:26 Uhr). Dieser Zug wird verspätet …"
   * Deliberately un-anchored at the end so trailing explanatory prose does not defeat it.
   */
  TRIP_ENTFAELLT_ZWISCHEN_FORMAT:
    /^(\d+)\s+entf(?:ä|ae)llt\s+zwischen\s+(.+?)\s+\(\s*(\d{1,2}:\d{2})\s*(?:Uhr)?\s*\)\s+und\s+(.+?)\s+\(\s*(\d{1,2}:\d{2})\s*(?:Uhr)?\s*\)/i,

  /**
   * Loose stop/time format tolerating optional parentheses around EITHER time independently:
   * <trainNumber> <fromStop> [(]<fromTime> Uhr[)] - <toStop> [(]<toTime> Uhr[)]
   * Example (asymmetric parens): "85879 Heilbronn Hbf (23:50 Uhr) - Sinsheim Hbf 00:48 Uhr"
   * A superset of the stricter stop/time formats, so it is tried LAST — only lines every
   * stricter format rejects reach it. Still requires a leading train number, which keeps
   * parenthesized date-ranges (no leading number) from matching.
   */
  TRIP_STOP_TIME_OPTIONAL_PARENTHESES_FORMAT:
    /^(\d+)\s+(.+?)\s+\(?\s*(\d{1,2}:\d{2})\s*(?:Uhr)?\s*\)?\s*[-–]+\s*(.+?)\s+\(?\s*(\d{1,2}:\d{2})\s*(?:Uhr)?\s*\)?\s*$/i,

  /**
   * Same parenthesized stop/time layout with the separator accidentally omitted.
   * Examples: "85029 Knielingen (21:41 Uhr) Pforzheim (22:50 Uhr)"
   *           "85617 Freudenstadt Stadt (08:32 Uhr) Freudenstadt Hbf. 08:37 Uhr)"
   * With no separator, the parentheses are what delimit the two stop/time pairs, so both times
   * must still be closed by ")" and the departure time fully parenthesized. Only the arrival
   * time's opening "(" may be missing — KVV drops it together with the separator — which keeps
   * this typo-tolerant form narrow.
   * The arrival stop may not begin with a separator: "56003 Ettlingen Albgaubad (01:28 Uhr) -
   * Neureut Kirchfeld 02:19 Uhr)" drops only the opening parenthesis and keeps the "-", so it
   * belongs to the optional-parentheses fallback below. Without the guard this format claims it
   * first and reads the separator as part of the stop name ("- Neureut Kirchfeld").
   */
  TRIP_STOP_TIME_CLOSING_PARENTHESES_MISSING_SEPARATOR_FORMAT:
    /^(\d+)\s+(.+?)\s+\(\s*(\d{1,2}:\d{2})\s*(?:Uhr)?\s*\)\s+(?![-–])(.+?)\s+\(?\s*(\d{1,2}:\d{2})\s*(?:Uhr)?\s*\)\s*$/i,

  /**
   * Matches trip format: <trainNumber> <time> Uhr <fromStop> - <time> Uhr <toStop>
   * Example: "84888 08:38 Uhr Söllingen Bahnhof - 10:07 Uhr Germersheim Bahnhof"
   */
  TRIP_TIME_STOP_FORMAT:
    /^(\d+)\s+(\d{1,2}:\d{2})(?:\s*Uhr)?\s+(.+?)\s*[-–]+\s*(\d{1,2}:\d{2})(?:\s*Uhr)?\s+(.+)/,

  /**
   * Same time/stop layout as {@link PATTERNS.TRIP_TIME_STOP_FORMAT} with no separator between the
   * two halves: KVV lays the row out in whitespace-aligned columns instead.
   * Example: "84877 05:50 Germersheim  07:17 Söllingen (b. Karlsruhe)"
   * With no "-" to split on, the column gap is the only field boundary, so at least two spaces
   * are required before the arrival time. A single space would make the row indistinguishable
   * from prose that happens to start with a number and a clock time; leaving such a row
   * unparsed surfaces it as a warning instead of inventing a trip from it.
   */
  TRIP_TIME_STOP_COLUMN_SEPARATED_FORMAT:
    /^(\d+)\s+(\d{1,2}:\d{2})(?:\s*Uhr)?\s+(.+?)\s{2,}(\d{1,2}:\d{2})(?:\s*Uhr)?\s+(.+)$/,

  /**
   * Matches trip format with line prefix: <line> <trainNumber> <fromStop> <time> Uhr - <toStop> <time> Uhr
   * Example: "S5 84957 Rheinbergstraße 05:02 Uhr - Pforzheim 06:11 Uhr"
   * This format includes the line identifier at the beginning of each trip line.
   */
  TRIP_LINE_PREFIX_FORMAT:
    /^([A-Z]+\d+)\s+(\d+)\s+(.+?)\s+(\d{1,2}:\d{2})(?:\s*Uhr)?\s*[-–]+\s*(.+?)\s+(\d{1,2}:\d{2})(?:\s*Uhr)?$/i,
} as const;

/**
 * A leading train number followed by a colon separator, as in
 * "10013: Ettlingen Stadt (06:04 Uhr) - Neureut Kirchfeld (06:51 Uhr)".
 * The colon is punctuation KVV sometimes adds, not part of any field layout, so candidate
 * lines drop it before format matching instead of every trip format tolerating it.
 * Requires at least three digits plus trailing whitespace so a leading clock time
 * ("10:30 Uhr Söllingen …") can never match.
 */
export const TRIP_ROW_TRAIN_NUMBER_COLON_PATTERN = /^(\d{3,})\s*:\s+/;

/**
 * A date row standing alone between trip rows — "06.07.2026", occasionally "6.7." — which KVV
 * inserts where a list runs past midnight, dating every row that follows it. Anchored at both
 * ends so it can only match a row that is *nothing but* a date, never a date inside prose.
 */
export const TRIP_LIST_DATE_ROW_PATTERN = /^(\d{1,2})\.(\d{1,2})\.(\d{4})?\.?$/;

/**
 * Text markers used to identify sections in the HTML.
 */
export const MARKERS = {
  /** Markers that precede the list of affected trips (multiple variants) */
  TRIPS_START: [
    'sind folgende Fahrten von einem (Teil-)Ausfall betroffen:',
    'sind folgende Fahrten betroffen:',
    'Betroffene Fahrten:',
    'Betroffene Fahrten;',
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
 * Matches: "Linie S1", "Linien: S1, S2", or "Linie(n): S1" followed by text until
 * period or newline.
 */
export const LINE_MENTION_SECTION_PATTERN = /Linien?(?:\(n\))?(?:\s*:\s*|\s+)([^.\n]+)/gi;

/**
 * Pattern to extract individual line identifiers.
 * Matches: Letter(s) followed by 1-3 digits (e.g., S1, S11, STR1).
 */
export const LINE_IDENTIFIER_PATTERN = /\b[A-Za-z]+\d{1,3}\b/g;

/**
 * Heuristic for "this line looks like a trip listing": two HH:MM times on one line
 * (departure + arrival). Used to detect trip-like content the parser failed to
 * structure, so it can be surfaced as a warning instead of being silently dropped.
 */
export const TRIP_TIME_PAIR_PATTERN = /\d{1,2}:\d{2}.*\d{1,2}:\d{2}/;

/**
 * A parenthesized stop time in the unnumbered route lists used by construction notices.
 * A single stop may carry arrival and departure times ("05:09 05:11").
 */
export const PARENTHESIZED_ROUTE_TIME_PATTERN =
  /\(\s*\d{1,2}:\d{2}(?:\s+\d{1,2}:\d{2})?(?:\s*Uhr)?\s*\)/gi;

/** A stop-to-stop separator, deliberately requiring surrounding whitespace. */
export const ROUTE_SEPARATOR_PATTERN = /\s[-–]\s/;

/**
 * A statement that a train takes a different route — it still runs, so there is no trip to
 * record. Construction notices are full of these ("Zug 84784 … wird … umgeleitet"), and their
 * train numbers are GTFS-known, which would otherwise read as a cancellation the parser missed.
 */
export const DIVERSION_STATEMENT_PATTERN = /\bumgeleitet\b|\bumleitung\b|\bumfahren\b/i;

/**
 * Evidence that a statement is about a trip *not running*. Checked before
 * {@link DIVERSION_STATEMENT_PATTERN} so a notice that cancels one trip and mentions a diversion
 * in the same breath ("… entfällt, SEV wird umgeleitet") stays a cancellation.
 */
export const CANCELLATION_STATEMENT_PATTERN =
  /\bentf(?:ä|ae)ll(?:t|en)\b|\bausfall\b|\bausf(?:ä|ae)lle\b|\bf(?:ä|ae)llt\s+aus\b/i;
