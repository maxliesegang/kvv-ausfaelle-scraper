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
    for (const preferred of normalizedPreferences) {
      const match = entry.lines.find((candidate) => candidate.toUpperCase() === preferred);
      if (match) return match;
    }
  }

  return entry.primaryLine;
}
