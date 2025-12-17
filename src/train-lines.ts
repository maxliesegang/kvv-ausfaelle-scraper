import type { TrainLineDefinition } from './train-line-definitions/types.js';
import { TRAIN_LINE_DEFINITIONS } from './train-line-definitions/index.js';
import { normalizeLine, normalizeLines } from './utils/normalization.js';

interface TrainLineMappingEntry {
  readonly primaryLine: string;
  readonly lines: readonly string[];
}

type TrainLineMapping = Readonly<Record<string, TrainLineMappingEntry>>;

/**
 * Builds a mapping from train numbers to their canonical line identifiers.
 * Allows train numbers to appear in multiple line definitions.
 */
function buildTrainLineMapping(definitions: readonly TrainLineDefinition[]): TrainLineMapping {
  const map: Record<string, { primaryLine: string; lines: string[] }> = {};

  for (const { line, trainNumbers } of definitions) {
    for (const trainNumber of trainNumbers) {
      const existing = map[trainNumber];
      if (!existing) {
        map[trainNumber] = { primaryLine: line, lines: [line] };
        continue;
      }

      if (existing.lines.includes(line)) {
        continue;
      }

      existing.lines.push(line);
    }
  }

  return map;
}

const TRAIN_LINE_MAPPING = buildTrainLineMapping(TRAIN_LINE_DEFINITIONS);
const LINE_TRAIN_COUNT: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries(TRAIN_LINE_DEFINITIONS.map((def) => [def.line, def.trainNumbers.length])),
);

/**
 * Checks if a line is valid within the context of mentioned lines.
 * A line is valid if it's one of the mentioned lines.
 */
export function isLineValidForMentionedLines(
  line: string,
  mentionedLines: readonly string[],
): boolean {
  const normalizedLine = normalizeLine(line);
  if (!normalizedLine) return false;

  const normalizedMentioned = normalizeLines(mentionedLines);

  return normalizedMentioned.includes(normalizedLine);
}

/**
 * Returns the canonical line for a given train number, if known.
 */
export function lookupLineForTrain(
  trainNumber: string,
  preferredLines?: readonly string[],
): string | undefined {
  const entry = TRAIN_LINE_MAPPING[trainNumber];
  if (!entry) return undefined;

  const normalizedPreferences = preferredLines ? normalizeLines(preferredLines) : [];

  if (normalizedPreferences.length > 0) {
    const matches = normalizedPreferences
      .map((preferred) => entry.lines.find((candidate) => candidate.toUpperCase() === preferred))
      .filter((line): line is string => Boolean(line));

    if (matches.length === 1) {
      return matches[0];
    }

    if (matches.length > 1) {
      // Prefer the line with the fewest train numbers (most specific definition)
      return matches.reduce((best, current) => {
        const bestSize = LINE_TRAIN_COUNT[best] ?? Number.MAX_SAFE_INTEGER;
        const currentSize = LINE_TRAIN_COUNT[current] ?? Number.MAX_SAFE_INTEGER;
        if (currentSize < bestSize) return current;
        return best;
      });
    }
  }

  return entry.primaryLine;
}
