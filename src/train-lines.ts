import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TrainLineDefinition } from './train-line-definitions/types.js';
import { TRAIN_LINE_DEFINITIONS } from './train-line-definitions/index.js';
import { normalizeLine, normalizeLines } from './utils/normalization.js';
import { getCurrentFahrplanYear } from './fahrplan.js';

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
 * Finds matching train numbers by removing the last digit from both
 * the search number and all existing train numbers.
 */
function findMatchingTrainsWithoutLastDigit(trainNumber: string): string[] {
  if (trainNumber.length < 2) return [];

  const searchPrefix = trainNumber.slice(0, -1);
  const matches: string[] = [];

  for (const existingTrainNumber of Object.keys(TRAIN_LINE_MAPPING)) {
    const existingPrefix = existingTrainNumber.slice(0, -1);
    if (existingPrefix === searchPrefix) {
      matches.push(existingTrainNumber);
    }
  }

  return matches;
}

/**
 * Adds a train number to a line definition file and persists it to disk.
 * Keeps train numbers sorted numerically.
 */
function addTrainNumberToLineDefinition(line: string, trainNumber: string): void {
  const year = getCurrentFahrplanYear();
  if (!year) {
    throw new Error('Cannot determine current Fahrplan year');
  }

  const fileName = `${line.toLowerCase()}.json`;
  const filePath = join(process.cwd(), 'docs', String(year), 'train-line-definitions', fileName);

  // Read the existing definition
  const fileContent = readFileSync(filePath, 'utf-8');
  const definition = JSON.parse(fileContent) as TrainLineDefinition;

  // Check if train number already exists
  if (definition.trainNumbers.includes(trainNumber)) {
    return; // Already present, nothing to do
  }

  // Add and sort train numbers
  const updatedTrainNumbers = [...definition.trainNumbers, trainNumber].sort((a, b) => {
    const numA = parseInt(a, 10);
    const numB = parseInt(b, 10);
    return numA - numB;
  });

  // Create updated definition
  const updatedDefinition: TrainLineDefinition = {
    ...definition,
    trainNumbers: updatedTrainNumbers,
  };

  // Write back to file with pretty formatting
  writeFileSync(filePath, JSON.stringify(updatedDefinition, null, 2) + '\n', 'utf-8');
}

/**
 * Selects the best line from an entry based on preferred lines.
 * Returns the selected line and whether it was found via preferences.
 */
function selectLineFromEntry(
  entry: TrainLineMappingEntry,
  preferredLines?: readonly string[],
): string {
  const normalizedPreferences = preferredLines ? normalizeLines(preferredLines) : [];

  if (normalizedPreferences.length > 0) {
    const matches = normalizedPreferences
      .map((preferred) => entry.lines.find((candidate) => candidate.toUpperCase() === preferred))
      .filter((line): line is string => line !== undefined);

    if (matches.length === 1) {
      return matches[0]!;
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

/**
 * Returns the canonical line for a given train number, if known.
 *
 * If no exact match is found, attempts a fallback search by removing
 * the last digit from the train number and finding matching trains.
 * When fallback matching succeeds, throws an error for manual verification.
 */
export function lookupLineForTrain(
  trainNumber: string,
  preferredLines?: readonly string[],
): string | undefined {
  // Try exact match first
  const entry = TRAIN_LINE_MAPPING[trainNumber];
  if (entry) {
    return selectLineFromEntry(entry, preferredLines);
  }

  // Fallback: Try matching without the last digit
  const matchingTrains = findMatchingTrainsWithoutLastDigit(trainNumber);

  if (matchingTrains.length === 0) {
    return undefined;
  }

  // Use the first matching train's entry and apply the same selection logic
  const firstMatch = matchingTrains[0];
  if (!firstMatch) {
    return undefined;
  }

  const fallbackEntry = TRAIN_LINE_MAPPING[firstMatch];
  if (!fallbackEntry) {
    return undefined;
  }

  const selectedLine = selectLineFromEntry(fallbackEntry, preferredLines);

  // Persist the train number to the line definition file
  addTrainNumberToLineDefinition(selectedLine, trainNumber);

  // Throw error for manual verification (causes build to fail and notify)
  throw new Error(
    `Train number ${trainNumber} not found - used fallback matching by removing last digit. ` +
      `Matched with: ${matchingTrains.join(', ')}. ` +
      `Selected line: ${selectedLine}. ` +
      `Train number has been added to ${selectedLine.toLowerCase()}.json. ` +
      `Please verify this match is correct and re-run if needed.`,
  );
}
