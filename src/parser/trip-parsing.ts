/**
 * Trip line parsing and validation utilities.
 */

import type { Cancellation, TripParsingMetadata } from '../types.js';
import { lookupLinesForTrip, type TripDescriptor } from '../train-lines.js';
import { normalizeLineUppercase } from '../utils/normalization.js';
import { MAX_LINES_TO_COMBINE } from '../utils/constants.js';
import {
  PATTERNS,
  MARKERS,
  DEFAULT_LINE,
  MULTI_LINE_HINT_PATTERN,
  MULTI_LINE_RANGE_PATTERN,
  LINE_MENTION_SECTION_PATTERN,
  LINE_IDENTIFIER_PATTERN,
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

const TRIP_START_PATTERNS = MARKERS.TRIPS_START.map(createFlexibleMarkerPattern);

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
 * through-run.
 *
 * @throws {MultiLineMappingError} When a multi-line article references a train number
 *   that maps to none of the mentioned lines (unknown, or needs an override).
 */
export function resolveLinesForTrip(
  trip: TripDescriptor,
  metadata: Pick<
    TripParsingMetadata,
    'line' | 'date' | 'mentionedLines' | 'lineMentionCount' | 'lineExplicitlyProvided'
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
    const lines = lookupLinesForTrip({ ...trip, date: metadata.date }, metadata.mentionedLines);
    if (lines.length > 0) {
      return lines;
    }

    if (isMultiLineArticle) {
      throw new MultiLineMappingError(
        `Multi-line article detected (${metadata.lineMentionCount} lines: ${metadata.mentionedLines.join(', ')}) ` +
          `but train ${trip.trainNumber} maps to none of them. Add it to a line definition for the ` +
          `current Fahrplan year, or to src/train-line-definitions/overrides.ts.`,
        trip.trainNumber,
      );
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
  /** Line identifier carried inline by the trip line (line-prefix format only). */
  readonly lineId?: string | undefined;
}

/**
 * A trip-line format: its regex plus how to map the captured groups onto trip fields.
 * The KVV pages use several human-written layouts that differ only in field order, so
 * each is described once here and processed by a single matcher loop. Order matters —
 * the most specific format (line-prefix) is tried first, the loosest (old) last.
 */
interface TripFormat {
  readonly pattern: RegExp;
  /** `'new'` formats reject stops captured as the literal "Uhr" (incomplete lines). */
  readonly validation: 'new' | 'old';
  readonly extract: (match: RegExpMatchArray) => ParsedTripFields;
}

const TRIP_FORMATS: readonly TripFormat[] = [
  // <line> <trainNumber> <fromStop> <time> Uhr - <toStop> <time> Uhr
  {
    pattern: PATTERNS.TRIP_LINE_PREFIX_FORMAT,
    validation: 'new',
    extract: (m) => ({
      lineId: m[1]?.toUpperCase(),
      trainNumber: m[2],
      fromStop: m[3],
      fromTime: m[4],
      toStop: m[5],
      toTime: m[6],
    }),
  },
  // <trainNumber> <fromStop> ab <fromTime> Uhr bis <toStop> an <toTime> Uhr
  {
    pattern: PATTERNS.TRIP_AB_BIS_FORMAT,
    validation: 'new',
    extract: (m) => ({
      trainNumber: m[1],
      fromStop: m[2],
      fromTime: m[3],
      toStop: m[4],
      toTime: m[5],
    }),
  },
  // <trainNumber> <fromStop> <time> Uhr - <toStop> <time> Uhr
  {
    pattern: PATTERNS.TRIP_STOP_TIME_FORMAT,
    validation: 'new',
    extract: (m) => ({
      trainNumber: m[1],
      fromStop: m[2],
      fromTime: m[3],
      toStop: m[4],
      toTime: m[5],
    }),
  },
  // <trainNumber> <time> Uhr <fromStop> - <time> Uhr <toStop>
  {
    pattern: PATTERNS.TRIP_NEW_FORMAT,
    validation: 'new',
    extract: (m) => ({
      trainNumber: m[1],
      fromTime: m[2],
      fromStop: m[3],
      toTime: m[4],
      toStop: m[5],
    }),
  },
  // <trainNumber> <fromStop> (<time>) - <toStop> (<time>)
  {
    pattern: PATTERNS.TRIP_OLD_FORMAT,
    validation: 'old',
    extract: (m) => ({
      trainNumber: m[1],
      fromStop: m[2],
      fromTime: m[3],
      toStop: m[4],
      toTime: m[5],
    }),
  },
];

/** A trip line whose fields are present and valid (the five core fields are non-null). */
interface ValidTripFields extends ParsedTripFields {
  readonly trainNumber: string;
  readonly fromStop: string;
  readonly fromTime: string;
  readonly toStop: string;
  readonly toTime: string;
}

/**
 * Matches a line against the known trip formats, returning the fields of the first
 * format whose regex matches and whose captured fields pass validation.
 */
function matchTripFormat(line: string): ValidTripFields | null {
  for (const { pattern, validation, extract } of TRIP_FORMATS) {
    const match = line.match(pattern);
    if (!match) continue;

    const fields = extract(match);
    if (
      isValidTripFields(
        fields.trainNumber,
        fields.fromStop,
        fields.fromTime,
        fields.toStop,
        fields.toTime,
        validation,
      )
    ) {
      return fields as ValidTripFields;
    }
  }
  return null;
}

/**
 * Checks whether a line of text looks like a parsable trip entry.
 */
export function isValidTripLine(line: string): boolean {
  return matchTripFormat(line) !== null;
}

/**
 * Splits a text block into trimmed candidate lines for trip parsing.
 */
export function buildTripCandidateLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) =>
      line
        // Replace HTML entities / non-breaking spaces before trimming
        .replace(/&nbsp;/gi, ' ')
        .replace(/\u00a0/g, ' ')
        .trim(),
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
 * Attempts to combine a line with subsequent lines to create a valid trip line.
 * @returns Combined line and number of lines consumed, or null if no valid combination found
 */
function tryMergeWithNext(
  rawLines: string[],
  startIndex: number,
  maxLinesToCombine: number = MAX_LINES_TO_COMBINE,
): { combinedLine: string; linesConsumed: number } | null {
  let combined = rawLines[startIndex] || '';

  for (
    let offset = 1;
    offset <= maxLinesToCombine && startIndex + offset < rawLines.length;
    offset++
  ) {
    combined = `${combined} ${rawLines[startIndex + offset] || ''}`.trim();
    if (isValidTripLine(combined)) {
      return { combinedLine: combined, linesConsumed: offset + 1 };
    }
  }

  return null;
}

/**
 * Merges lines that belong together and filters out invalid ones.
 *
 * This handles cases where trip information is split across multiple lines
 * by attempting to combine up to 3 consecutive lines to form valid trip entries.
 */
export function mergeTripLines(rawLines: string[]): string[] {
  const mergedLines: string[] = [];
  let i = 0;

  while (i < rawLines.length) {
    const currentLine = rawLines[i] || '';

    // If the line is already valid, use it as-is
    if (isValidTripLine(currentLine)) {
      mergedLines.push(currentLine);
      i++;
      continue;
    }

    // Try to combine with next lines to create a valid trip line
    const mergeResult = tryMergeWithNext(rawLines, i);
    if (mergeResult) {
      mergedLines.push(mergeResult.combinedLine);
      i += mergeResult.linesConsumed;
    } else {
      // No valid combination found, skip this line
      i++;
    }
  }

  return mergedLines;
}

/**
 * Extracts raw candidate lines from the trip section without validation or merging.
 * Useful for diagnostics when no trips could be parsed.
 */
export function extractTripSectionCandidates(text: string): string[] {
  const tripSection = findTripSection(text);
  return buildTripCandidateLines(tripSection ?? text);
}

/**
 * Extracts the section of text containing trip listings.
 *
 * @param text - Full plain text content
 * @returns Array of trip lines, or empty array if section not found
 */
export function extractTripLines(text: string): string[] {
  const tripSection = findTripSection(text);

  if (tripSection) {
    const tripLines = parseTripLinesFromSection(tripSection);
    if (tripLines.length > 0) {
      return tripLines;
    }
  }

  return parseTripLinesFromSection(text);
}

function findTripSection(text: string): string | undefined {
  for (const pattern of TRIP_START_PATTERNS) {
    const match = pattern.exec(text);
    if (match) {
      return text.slice(match.index + match[0].length);
    }
  }

  return undefined;
}

function parseTripLinesFromSection(section: string): string[] {
  const rawLines = buildTripCandidateLines(section);
  if (rawLines.length === 0) {
    return [];
  }

  return mergeTripLines(rawLines);
}

/**
 * Validates parsed trip fields.
 */
function isValidTripFields(
  trainNumber: string | undefined,
  fromStop: string | undefined,
  fromTime: string | undefined,
  toStop: string | undefined,
  toTime: string | undefined,
  format: 'new' | 'old',
): boolean {
  if (!trainNumber || !fromStop || !fromTime || !toStop || !toTime) {
    return false;
  }

  // New format requires stops not to be just "Uhr" (indicates incomplete line)
  if (format === 'new') {
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
  };
}

/**
 * Parses a single trip line into Cancellation objects — one per line the trip is
 * reported under (usually one; several when a number runs on multiple mentioned lines).
 *
 * @param line - Trip line text to parse
 * @param metadata - Common metadata for all trips
 * @returns Cancellations for this trip line, or an empty array if it is not a trip line
 * @throws {MultiLineMappingError} via {@link resolveLinesForTrip} for unmappable numbers
 */
export function parseTripLine(line: string, metadata: TripParsingMetadata): Cancellation[] {
  const fields = matchTripFormat(line);
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
