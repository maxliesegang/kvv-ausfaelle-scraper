/**
 * Trip row parsing and validation utilities.
 *
 * Naming: a **row** is one line of article text (a candidate trip entry); a **line** is
 * always a transit line (`S5`). KVV's notices list one trip per row, so the two meanings
 * sit side by side in this file and are kept lexically distinct on purpose.
 */

import type { Cancellation, TripParsingMetadata } from '../types.js';
import {
  lookupLinesForTrip,
  lookupLinesForUnmentionedTrip,
  type TripDescriptor,
} from '../train-lines.js';
import { extractDetailId, normalizeLineUppercase } from '../utils/normalization.js';
import { assignTripDates, parseTripListDateRow, type TripDateAnchor } from './trip-dates.js';
import { MAX_ROWS_TO_COMBINE } from '../utils/constants.js';
import {
  PATTERNS,
  MARKERS,
  DEFAULT_LINE,
  MULTI_LINE_HINT_PATTERN,
  MULTI_LINE_RANGE_PATTERN,
  LINE_MENTION_SECTION_PATTERN,
  LINE_IDENTIFIER_PATTERN,
  TRIP_TIME_PAIR_PATTERN,
  TRIP_ROW_TRAIN_NUMBER_COLON_PATTERN,
  PARENTHESIZED_ROUTE_TIME_PATTERN,
  ROUTE_SEPARATOR_PATTERN,
  DIVERSION_STATEMENT_PATTERN,
  CANCELLATION_STATEMENT_PATTERN,
} from './patterns.js';

export class MultiLineMappingError extends Error {
  constructor(
    message: string,
    readonly trainNumber: string,
  ) {
    super(message);
    this.name = 'MultiLineMappingError';
  }
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createFlexibleMarkerPattern(marker: string): RegExp {
  return new RegExp(escapeRegexLiteral(marker).replace(/\s+/g, '\\s+'), 'i');
}

const TRIP_SECTION_START_PATTERNS = MARKERS.TRIPS_START.map(createFlexibleMarkerPattern);

/**
 * Determines whether the parsed line value looks ambiguous (e.g. "S1 und S11").
 */
export function isAmbiguousLine(line: string): boolean {
  if (!line || line === DEFAULT_LINE) return true;
  if (MULTI_LINE_HINT_PATTERN.test(line)) return true;
  if (MULTI_LINE_RANGE_PATTERN.test(line)) return true;
  return false;
}

/**
 * Resolves the line(s) a trip should be reported under.
 *
 * Explicit (line-prefix) and single-line-mention articles yield exactly that line. For a
 * multi-line article the train number is resolved against the train-line mapping: a shared
 * number is disambiguated by the article's date and the trip's departure/arrival times
 * (see `train-lines.ts`), reporting one line for a recycled run and several for a
 * through-run. An article naming no line at all resolves from the train number alone.
 *
 * Falls back to {@link DEFAULT_LINE} only when nothing identifies the line — GTFS does not know
 * the number either. Those trips are still published (the cancellation is real) and reported by
 * `index.ts` so CI flags them as a notification, the same way an unclassified cause is.
 *
 * @throws {MultiLineMappingError} When a multi-line article references a train number
 *   that maps to none of the mentioned lines (unknown, or needs an override).
 */
export function resolveLinesForTrip(
  trip: TripDescriptor,
  metadata: Pick<
    TripParsingMetadata,
    'line' | 'date' | 'mentionedLines' | 'lineMentionCount' | 'lineExplicitlyProvided' | 'sourceUrl'
  >,
): string[] {
  const articleLine = normalizeLineUppercase(metadata.line) || DEFAULT_LINE;
  const canUseArticleLine = !isAmbiguousLine(articleLine) && articleLine !== DEFAULT_LINE;
  const hasSingleLineMention = metadata.lineMentionCount === 1;
  const isMultiLineArticle = metadata.lineMentionCount > 1;

  // If the line is explicit (line-prefix format) or the article mentions a single line,
  // use it directly without consulting the train-number mapping.
  if (metadata.lineExplicitlyProvided && canUseArticleLine) {
    return [articleLine];
  }
  if (hasSingleLineMention && canUseArticleLine) {
    return [articleLine];
  }

  if (metadata.lineMentionCount > 0) {
    const detailId = extractDetailId(metadata.sourceUrl);
    const lines = lookupLinesForTrip(
      { ...trip, date: metadata.date },
      metadata.mentionedLines,
      detailId,
    );
    if (lines.length > 0) {
      return lines;
    }

    if (isMultiLineArticle) {
      throw new MultiLineMappingError(
        `Multi-line article detected (${metadata.lineMentionCount} lines: ${metadata.mentionedLines.join(', ')}) ` +
          `but train ${trip.trainNumber} maps to none of them. Add it to a line definition for the ` +
          `current Fahrplan year, or add an article-scoped entry (detailID ${detailId ?? '?'}) ` +
          `to src/train-line-definitions/overrides.ts.`,
        trip.trainNumber,
      );
    }
  } else if (articleLine === DEFAULT_LINE) {
    // The article names no line and none could be extracted from its text. Rather than filing
    // the trip under DEFAULT_LINE — a bucket no consumer browsing by line looks in — resolve it
    // from the train number alone; with no mentions there is nothing to constrain it against.
    const lines = lookupLinesForUnmentionedTrip({ ...trip, date: metadata.date });
    if (lines.length > 0) {
      return lines;
    }
  }

  return [articleLine];
}

/** Trip fields extracted from a matched format, before validation. */
interface ParsedTripFields {
  readonly trainNumber?: string | undefined;
  readonly fromStop?: string | undefined;
  readonly fromTime?: string | undefined;
  readonly toStop?: string | undefined;
  readonly toTime?: string | undefined;
  /** Transit line carried inline by the trip row (line-prefix format only). */
  readonly lineId?: string | undefined;
}

/**
 * A trip-row format: its regex plus how to map the captured groups onto trip fields.
 * The KVV pages use several human-written layouts that differ only in field order, so
 * each is described once here and processed by a single matcher loop. Order matters —
 * the most specific format (line-prefix) is tried first and the loosest fallback last.
 */
interface TripFormat {
  readonly pattern: RegExp;
  /** Rejects incomplete rows where a stop capture contains only the time suffix "Uhr". */
  readonly rejectUhrOnlyStops: boolean;
  readonly extract: (match: RegExpMatchArray) => ParsedTripFields;
}

/**
 * Group extractors shared by formats with the same capture-group layout. Most trip formats
 * capture the same five fields in one of two orders, so naming the two orders keeps the
 * format table below a compact spec: a new same-shaped format is one line.
 */
const EXTRACT = {
  /** `<num> <fromStop> <fromTime> <toStop> <toTime>` — the common human-written order. */
  stopThenTime: (m: RegExpMatchArray): ParsedTripFields => ({
    trainNumber: m[1],
    fromStop: m[2],
    fromTime: m[3],
    toStop: m[4],
    toTime: m[5],
  }),
  /** `<num> <fromTime> <fromStop> <toTime> <toStop>` — time before stop on each side. */
  timeThenStop: (m: RegExpMatchArray): ParsedTripFields => ({
    trainNumber: m[1],
    fromTime: m[2],
    fromStop: m[3],
    toTime: m[4],
    toStop: m[5],
  }),
  /** `<line> <num> <fromStop> <fromTime> <toStop> <toTime>` — line-prefixed variant. */
  linePrefix: (m: RegExpMatchArray): ParsedTripFields => ({
    lineId: m[1]?.toUpperCase(),
    trainNumber: m[2],
    fromStop: m[3],
    fromTime: m[4],
    toStop: m[5],
    toTime: m[6],
  }),
} as const;

const TRIP_FORMATS: readonly TripFormat[] = [
  // <line> <trainNumber> <fromStop> <time> Uhr - <toStop> <time> Uhr
  {
    pattern: PATTERNS.TRIP_LINE_PREFIX_FORMAT,
    rejectUhrOnlyStops: true,
    extract: EXTRACT.linePrefix,
  },
  // <trainNumber> <fromStop> ab <fromTime> Uhr bis <toStop> an <toTime> Uhr
  {
    pattern: PATTERNS.TRIP_AB_BIS_FORMAT,
    rejectUhrOnlyStops: true,
    extract: EXTRACT.stopThenTime,
  },
  // <trainNumber> entfällt zwischen <fromStop> (<time>) und <toStop> (<time>)
  {
    pattern: PATTERNS.TRIP_ENTFAELLT_ZWISCHEN_FORMAT,
    rejectUhrOnlyStops: true,
    extract: EXTRACT.stopThenTime,
  },
  // <trainNumber> <fromStop> <time> Uhr - <toStop> <time> Uhr
  {
    pattern: PATTERNS.TRIP_STOP_TIME_FORMAT,
    rejectUhrOnlyStops: true,
    extract: EXTRACT.stopThenTime,
  },
  // <trainNumber> <time> Uhr <fromStop> - <time> Uhr <toStop>
  {
    pattern: PATTERNS.TRIP_TIME_STOP_FORMAT,
    rejectUhrOnlyStops: true,
    extract: EXTRACT.timeThenStop,
  },
  // <trainNumber> <fromStop> (<time>) - <toStop> (<time>)
  {
    pattern: PATTERNS.TRIP_STOP_TIME_REQUIRED_PARENTHESES_FORMAT,
    rejectUhrOnlyStops: false,
    extract: EXTRACT.stopThenTime,
  },
  // A narrowly tolerated KVV typo: both times closed by ")" but the separator is absent.
  {
    pattern: PATTERNS.TRIP_STOP_TIME_CLOSING_PARENTHESES_MISSING_SEPARATOR_FORMAT,
    rejectUhrOnlyStops: true,
    extract: EXTRACT.stopThenTime,
  },
  // Loosest fallback: <trainNumber> <fromStop> [(]<time>[)] - <toStop> [(]<time>[)]
  // (optional parentheses on either time). It must stay LAST because it is a superset of the
  // stricter stop/time formats and only catches lines every earlier format rejected.
  {
    pattern: PATTERNS.TRIP_STOP_TIME_OPTIONAL_PARENTHESES_FORMAT,
    rejectUhrOnlyStops: true,
    extract: EXTRACT.stopThenTime,
  },
];

/** A trip row whose fields are present and valid (the five core fields are non-null). */
interface ValidTripFields extends ParsedTripFields {
  readonly trainNumber: string;
  readonly fromStop: string;
  readonly fromTime: string;
  readonly toStop: string;
  readonly toTime: string;
}

/**
 * Matches a row against the known trip formats, returning the fields of the first
 * format whose regex matches and whose captured fields pass validation.
 */
function matchTripFormat(row: string): ValidTripFields | null {
  for (const { pattern, rejectUhrOnlyStops, extract } of TRIP_FORMATS) {
    const match = row.match(pattern);
    if (!match) continue;

    const fields = extract(match);
    if (isValidTripFields(fields, rejectUhrOnlyStops)) {
      return fields;
    }
  }
  return null;
}

/**
 * Checks whether a row of article text looks like a parsable trip entry.
 */
export function isValidTripRow(row: string): boolean {
  return matchTripFormat(row) !== null;
}

/**
 * Splits a text block into trimmed candidate rows for trip parsing.
 */
export function buildTripCandidateRows(text: string): string[] {
  return text
    .split('\n')
    .map((line) =>
      line
        // Replace HTML entities / non-breaking spaces before trimming
        .replace(/&nbsp;/gi, ' ')
        .replace(/\u00a0/g, ' ')
        .trim()
        // Drop the colon KVV sometimes puts after the leading train number
        .replace(TRIP_ROW_TRAIN_NUMBER_COLON_PATTERN, '$1 '),
    )
    .filter((line) => {
      if (!line) return false;
      if (line.startsWith(MARKERS.TRIPS_END)) return false;
      if (line.startsWith('(Zug wird')) return false;
      if (line === '&nbsp;') return false;
      if (line.includes('in Richtung') && line.includes('eingesetzt)')) return false;
      return true;
    });
}

/**
 * Extracts how many distinct lines are explicitly mentioned in the article text.
 */
export function extractMentionedLines(text: string): string[] {
  const mentions = new Set<string>();
  let match: RegExpExecArray | null;

  while ((match = LINE_MENTION_SECTION_PATTERN.exec(text)) !== null) {
    const section = match[1] ?? '';
    const tokens = section.match(LINE_IDENTIFIER_PATTERN);
    if (!tokens) continue;
    for (const token of tokens) {
      mentions.add(token.toUpperCase());
    }
  }

  return Array.from(mentions);
}

/**
 * Attempts to combine a row with subsequent rows to form a valid trip row.
 * @returns Combined row and number of rows consumed, or null if no valid combination found
 */
function tryMergeWithNext(
  rawRows: string[],
  startIndex: number,
  maxRowsToCombine: number = MAX_ROWS_TO_COMBINE,
): { combinedRow: string; rowsConsumed: number } | null {
  let combined = rawRows[startIndex] || '';

  for (
    let offset = 1;
    offset <= maxRowsToCombine && startIndex + offset < rawRows.length;
    offset++
  ) {
    const nextRow = rawRows[startIndex + offset] || '';
    // A new leading train number is a hard row boundary. Without this guard, one malformed
    // row can consume one or more valid following rows until the concatenation happens to
    // satisfy a loose format, producing a corrupted trip and silently losing the rest.
    const nextRowStartsTripRow = /^(?:[A-Za-z]+\d+\s+)?\d{4,6}(?:\s|$)/.test(nextRow);
    const combinedRowIsStandaloneLinePrefix = /^[A-Za-z]+\d+\s*$/.test(combined);
    if (nextRowStartsTripRow && !combinedRowIsStandaloneLinePrefix) {
      break;
    }
    combined = `${combined} ${nextRow}`.trim();
    if (isValidTripRow(combined)) {
      return { combinedRow: combined, rowsConsumed: offset + 1 };
    }
  }

  return null;
}

/** A merged trip row plus the index of the raw row it starts at. */
interface MergedTripRow {
  readonly row: string;
  /** Index into `rawRows` of the row this one begins at — where its date context is read. */
  readonly rawIndex: number;
  /** Number of raw rows represented by this merged row. */
  readonly rowsConsumed: number;
}

/**
 * Merges rows that belong together and filters out invalid ones, keeping each result's
 * position in `rawRows` so callers can relate it back to what preceded it (a date row).
 */
function mergeTripRowsWithPositions(rawRows: string[]): MergedTripRow[] {
  const mergedRows: MergedTripRow[] = [];
  let i = 0;

  while (i < rawRows.length) {
    const currentRow = rawRows[i] || '';

    // If the line is already valid, use it as-is
    if (isValidTripRow(currentRow)) {
      mergedRows.push({ row: currentRow, rawIndex: i, rowsConsumed: 1 });
      i++;
      continue;
    }

    // Try to combine with next lines to create a valid trip line
    const mergeResult = tryMergeWithNext(rawRows, i);
    if (mergeResult) {
      mergedRows.push({
        row: mergeResult.combinedRow,
        rawIndex: i,
        rowsConsumed: mergeResult.rowsConsumed,
      });
      i += mergeResult.rowsConsumed;
    } else {
      // No valid combination found, skip this line
      i++;
    }
  }

  return mergedRows;
}

/**
 * Extracts raw candidate rows from the trip section without validation or merging.
 * Useful for diagnostics when no trips could be parsed.
 */
export function extractTripSectionCandidateRows(text: string): string[] {
  const tripSection = findTripSection(text);
  return buildTripCandidateRows(tripSection ?? text);
}

/**
 * The leading 4–6 digit train number of a trip row, optionally after a line prefix and/or
 * before a colon. Clock times and dates are deliberately excluded.
 */
export function leadingTrainNumber(row: string): string | undefined {
  return row.match(/^(?:[A-Za-z]+\d+\s+)?(\d{4,6})(?=\s|:|$)/)?.[1];
}

/**
 * Whether an unnumbered row has the observable shape of a stop-to-stop route: at least two
 * parenthesized clock times and a spaced dash separator. This keeps route listings visible
 * without treating operating periods, frequency descriptions, and date ranges as missed trips.
 */
function isUnnumberedRouteRow(row: string): boolean {
  const times = row.match(PARENTHESIZED_ROUTE_TIME_PATTERN);
  return times !== null && times.length >= 2 && ROUTE_SEPARATOR_PATTERN.test(row);
}

/**
 * Whether a row states that a train is **diverted** rather than cancelled.
 *
 * A diverted train still runs, so there is no cancellation to parse — but construction notices
 * name it with its GTFS-known Zugnummer ("Zug 84784 Söllingen Reetzstraße ab 01:02 Uhr:" /
 * "Wird ab … umgeleitet."), which otherwise reads exactly like a real cancellation in a format
 * the parser does not cover, and escalates to a hard error. KVV writes these as a heading row
 * naming the train followed by a description row, so the following row is part of the same
 * statement and is inspected with it — unless it starts a new numbered row, the same hard
 * boundary multiline recovery uses.
 *
 * Cancellation wording wins: a notice that cancels a trip and mentions a diversion in the same
 * statement is a cancellation, not a diversion.
 */
export function isDiversionRow(row: string, followingRow?: string): boolean {
  const continuesStatement =
    followingRow !== undefined && leadingTrainNumber(followingRow) === undefined;
  const statement = continuesStatement ? `${row} ${followingRow}` : row;

  if (CANCELLATION_STATEMENT_PATTERN.test(statement)) {
    return false;
  }
  return DIVERSION_STATEMENT_PATTERN.test(statement);
}

/**
 * Raw, pre-merge trip-like rows the parser could not structure.
 *
 * `extractTripRows` merges and filters candidate lines, so a row it cannot parse never
 * reaches parsing and is silently dropped. This scans the RAW candidates instead and
 * returns every numbered row with two clock times, plus unnumbered rows shaped like a
 * stop-to-stop route, that matches no known format. A numbered row already captured elsewhere
 * (e.g. via a multi-line merge) is excluded, as is a row that states a **diversion** rather than
 * a cancellation (see {@link isDiversionRow}) — that train runs, so there is nothing to parse.
 * Used both to warn and to drive the known-number tripwire in the workflow.
 */
export function findUnparsedTripLikeRows(
  text: string,
  parsedTrainNumbers: ReadonlySet<string>,
): string[] {
  const { rawRows, mergedRows } = selectTripRows(text);
  const consumedRawIndexes = new Set<number>();
  for (const merged of mergedRows) {
    for (let offset = 0; offset < merged.rowsConsumed; offset++) {
      consumedRawIndexes.add(merged.rawIndex + offset);
    }
  }

  return rawRows.filter((row, index) => {
    // Do not report a continuation row that was successfully consumed into a multiline trip.
    if (consumedRawIndexes.has(index)) return false;
    if (isValidTripRow(row)) return false;
    if (isDiversionRow(row, rawRows[index + 1])) return false;
    const number = leadingTrainNumber(row);
    if (number !== undefined) {
      return TRIP_TIME_PAIR_PATTERN.test(row) && !parsedTrainNumbers.has(number);
    }
    return isUnnumberedRouteRow(row);
  });
}

/**
 * Extracts the section of text containing trip listings.
 *
 * @param text - Full plain text content
 * @returns Array of trip rows, or empty array if section not found
 */
export function extractTripRows(text: string): string[] {
  return selectTripRows(text).mergedRows.map((merged) => merged.row);
}

/**
 * The rows the parser works from: the trip section's when it yields any, the whole text's
 * otherwise. Raw and merged rows are returned together because a merged row's `rawIndex` only
 * means anything against the very list it was merged from.
 */
function selectTripRows(text: string): { rawRows: string[]; mergedRows: MergedTripRow[] } {
  const tripSection = findTripSection(text);

  if (tripSection !== undefined) {
    const rawRows = buildTripCandidateRows(tripSection);
    const mergedRows = mergeTripRowsWithPositions(rawRows);
    if (mergedRows.length > 0) {
      return { rawRows, mergedRows };
    }
  }

  const rawRows = buildTripCandidateRows(text);
  return { rawRows, mergedRows: mergeTripRowsWithPositions(rawRows) };
}

/** A trip row together with the date the article says it departs on. */
export interface DatedTripRow {
  readonly row: string;
  /** ISO date (YYYY-MM-DD) the trip departs on, per {@link assignTripDates}. */
  readonly date: string;
}

/**
 * Extracts the article's trip rows, each carrying the date it departs on.
 *
 * Dating is a property of the *list*, not of a row on its own: an explicit date row governs the
 * rows after it, and the chronological order of the rows reveals a midnight crossing. See
 * `trip-dates.ts` for the rules and why a row's own time can never decide its day.
 */
export function extractDatedTripRows(text: string, anchor: TripDateAnchor): DatedTripRow[] {
  const { rawRows, mergedRows } = selectTripRows(text);

  // An explicit date row governs every trip row after it, so each merged row inherits the last
  // date row at or before the raw row it starts at.
  const explicitDateByRawIndex: (string | undefined)[] = [];
  let explicitDate: string | undefined;
  for (const rawRow of rawRows) {
    explicitDate = parseTripListDateRow(rawRow, anchor.date) ?? explicitDate;
    explicitDateByRawIndex.push(explicitDate);
  }

  const dates = assignTripDates(
    mergedRows.map((merged) => ({
      departureTime: matchTripFormat(merged.row)?.fromTime,
      explicitDate: explicitDateByRawIndex[merged.rawIndex],
    })),
    anchor,
  );

  return mergedRows.map((merged, index) => ({
    row: merged.row,
    date: dates[index] ?? anchor.date,
  }));
}

function findTripSection(text: string): string | undefined {
  for (const pattern of TRIP_SECTION_START_PATTERNS) {
    const match = pattern.exec(text);
    if (match) {
      return text.slice(match.index + match[0].length);
    }
  }

  return undefined;
}

/**
 * Whether all five core fields were captured — and, for formats that need it, that neither
 * stop is the bare time suffix "Uhr" (the signature of a row a loose format mis-split).
 *
 * Narrows to {@link ValidTripFields} so a passing match needs no cast at the call site.
 */
function isValidTripFields(
  fields: ParsedTripFields,
  rejectUhrOnlyStops: boolean,
): fields is ValidTripFields {
  const { trainNumber, fromStop, fromTime, toStop, toTime } = fields;
  if (!trainNumber || !fromStop || !fromTime || !toStop || !toTime) {
    return false;
  }

  if (rejectUhrOnlyStops) {
    return toStop.trim() !== 'Uhr' && fromStop.trim() !== 'Uhr';
  }

  return true;
}

/**
 * Builds a Cancellation object for a single resolved line from parsed trip fields.
 */
function buildCancellation(
  line: string,
  fields: ValidTripFields,
  metadata: TripParsingMetadata,
): Cancellation {
  return {
    line,
    date: metadata.date,
    stand: metadata.stand,
    trainNumber: fields.trainNumber,
    fromStop: fields.fromStop.trim(),
    fromTime: fields.fromTime,
    toStop: fields.toStop.trim(),
    toTime: fields.toTime,
    sourceUrl: metadata.sourceUrl,
    capturedAt: metadata.capturedAt,
    cause: metadata.cause,
    causeKeyword: metadata.causeKeyword,
  };
}

/**
 * Parses a single trip row into Cancellation objects — one per transit line the trip is
 * reported under (usually one; several when a number runs on multiple mentioned lines).
 *
 * @param row - Trip row text to parse
 * @param metadata - Common metadata for all trips
 * @returns Cancellations for this trip row, or an empty array if it is not a trip row
 * @throws {MultiLineMappingError} via {@link resolveLinesForTrip} for unmappable numbers
 */
export function parseTripRow(row: string, metadata: TripParsingMetadata): Cancellation[] {
  const fields = matchTripFormat(row);
  if (!fields) {
    return [];
  }

  // The line-prefix format carries its own line identifier; prefer it over the
  // article-level line and mark it explicit so train-number mappings aren't required.
  const effectiveMetadata: TripParsingMetadata = fields.lineId
    ? { ...metadata, line: fields.lineId, lineExplicitlyProvided: true }
    : metadata;

  const lines = resolveLinesForTrip(
    { trainNumber: fields.trainNumber, fromTime: fields.fromTime, toTime: fields.toTime },
    effectiveMetadata,
  );
  return lines.map((resolvedLine) => buildCancellation(resolvedLine, fields, effectiveMetadata));
}
