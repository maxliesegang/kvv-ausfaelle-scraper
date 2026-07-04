import type { TrainLineDefinition } from './train-line-definitions/types.js';
import { TRAIN_LINE_DEFINITIONS } from './train-line-definitions/index.js';
import { TRAIN_LINE_OVERRIDES } from './train-line-definitions/overrides.js';
import {
  loadAmbiguousTrips,
  resolveAmbiguousTrip,
  type TripSignature,
} from './train-line-definitions/ambiguous-trips.js';
import { getCurrentFahrplanYear } from './fahrplan.js';
import {
  normalizeLineUppercase,
  normalizeLines,
  normalizeTrainNumber,
} from './utils/normalization.js';

/**
 * Reverse index: train number → the line(s) that own it.
 *
 * A number may belong to several lines — sibling lines such as S5/S51/S52 share number
 * blocks, and GTFS reuses the same Zugnummer for distinct trips on connected lines
 * (e.g. S5/S6 at Pforzheim). For these shared numbers the flat index only says "one of
 * these lines"; {@link AmbiguousTripIndex} disambiguates by date + time.
 */
export interface TrainLineIndex {
  readonly exact: Readonly<Record<string, readonly string[]>>;
}

/** train number → its trip signatures (only numbers that run on more than one line). */
export type AmbiguousTripIndex = Readonly<Record<string, readonly TripSignature[]>>;

/** The trip fields the resolver needs to disambiguate a shared number. */
export interface TripDescriptor {
  readonly trainNumber: string;
  readonly fromTime?: string;
  readonly toTime?: string;
  /** Article ISO date `YYYY-MM-DD`. */
  readonly date?: string;
}

/** Builds the train number → lines index from a set of definitions. */
export function buildTrainLineIndex(definitions: readonly TrainLineDefinition[]): TrainLineIndex {
  const exact: Record<string, string[]> = {};
  for (const { line, trainNumbers } of definitions) {
    const normalizedLine = normalizeLineUppercase(line);
    if (!normalizedLine) continue;

    for (const rawTrainNumber of trainNumbers) {
      const trainNumber = normalizeTrainNumber(rawTrainNumber);
      if (!trainNumber) continue;

      const lines = (exact[trainNumber] ??= []);
      if (!lines.includes(normalizedLine)) lines.push(normalizedLine);
    }
  }
  return { exact };
}

const TRAIN_LINE_INDEX = buildTrainLineIndex(TRAIN_LINE_DEFINITIONS);
const AMBIGUOUS_TRIPS: AmbiguousTripIndex = loadAmbiguousTrips();
/** Per-article overrides for the current Fahrplan year: detailID → train number → line. */
const OVERRIDES: Readonly<Record<string, Readonly<Record<string, string>>>> =
  TRAIN_LINE_OVERRIDES[getCurrentFahrplanYear() ?? -1] ?? {};

/**
 * Resolves a curated override for a number, or `undefined` if there is none. An override
 * still only applies when the article mentions its line (it forces a number onto a line,
 * it does not invent a cancellation on an unmentioned line).
 */
function resolveOverride(
  trainNumber: string,
  mentioned: ReadonlySet<string>,
  overrides: Readonly<Record<string, string>>,
): string[] | undefined {
  const override = overrides[trainNumber];
  if (!override) return undefined;
  const normalizedOverride = normalizeLineUppercase(override);
  if (!normalizedOverride) return [];
  return mentioned.has(normalizedOverride) ? [normalizedOverride] : [];
}

/**
 * Resolves the line(s) a train number should be reported under in a multi-line article,
 * using only the flat index (no timing signatures).
 *
 * The number's GTFS lines are intersected with the lines the article mentions: the
 * result is EVERY mentioned line the number runs on. GTFS reuses one Zugnummer across
 * connected lines (e.g. an S5 trip and an S6 trip), so a cancellation can legitimately
 * belong to several of the mentioned lines and is reported under each. A curated override
 * wins over GTFS, but only if that override line is mentioned by the article. Empty means
 * the number maps to none of the mentioned lines, or is unknown.
 */
export function resolveLinesInIndex(
  index: TrainLineIndex,
  trainNumber: string,
  mentionedLines: readonly string[],
  overrides: Readonly<Record<string, string>> = {},
): string[] {
  const normalizedTrainNumber = normalizeTrainNumber(trainNumber);
  if (!normalizedTrainNumber) return [];

  const mentioned = new Set(normalizeLines(mentionedLines));

  const fromOverride = resolveOverride(normalizedTrainNumber, mentioned, overrides);
  if (fromOverride) return fromOverride;

  const lines = index.exact[normalizedTrainNumber];
  if (!lines || lines.length === 0) return [];

  return lines.filter((line) => mentioned.has(line));
}

/**
 * Resolves the line(s) for a trip against both the timing-signature sidecar and the flat
 * index. Pure (all data passed in) so it can be unit-tested without disk.
 *
 * Order of evidence:
 *  1. A curated override wins (still must be a mentioned line).
 *  2. If the number has timing signatures, match date + departure/arrival times. A
 *     confident match is authoritative — it may report a line the article did not
 *     explicitly mention, because the signature is stronger evidence than mention
 *     extraction (it both fixes recycled over-reporting and keeps through-running). An
 *     unconfident match falls back to intersecting the candidate lines with the mentioned
 *     ones, matching the flat-index behavior.
 *  3. Otherwise fall back to the flat index intersected with the mentioned lines.
 */
export function resolveLines(
  index: TrainLineIndex,
  ambiguous: AmbiguousTripIndex,
  trip: TripDescriptor,
  mentionedLines: readonly string[],
  overrides: Readonly<Record<string, string>> = {},
): string[] {
  const normalizedTrainNumber = normalizeTrainNumber(trip.trainNumber);
  if (!normalizedTrainNumber) return [];

  const mentioned = new Set(normalizeLines(mentionedLines));

  const fromOverride = resolveOverride(normalizedTrainNumber, mentioned, overrides);
  if (fromOverride) return fromOverride;

  const signatures = ambiguous[normalizedTrainNumber];
  if (signatures && signatures.length > 0) {
    const { lines, confident } = resolveAmbiguousTrip(signatures, trip);
    if (confident) return lines;
    return lines.filter((line) => mentioned.has(line));
  }

  return resolveLinesInIndex(index, normalizedTrainNumber, mentionedLines, overrides);
}

/**
 * Returns the line(s) a trip should be reported under, using the definitions, timing
 * signatures and overrides loaded for the current Fahrplan year. Empty means it could not
 * be resolved (see {@link resolveLines}).
 */
export function lookupLinesForTrip(
  trip: TripDescriptor,
  mentionedLines: readonly string[],
  detailId?: string,
): string[] {
  // Overrides are scoped to a single article, so select this article's map (if any) before
  // resolving; a number with no entry for this article resolves purely from GTFS.
  const overrides = (detailId && OVERRIDES[detailId]) || {};
  return resolveLines(TRAIN_LINE_INDEX, AMBIGUOUS_TRIPS, trip, mentionedLines, overrides);
}
