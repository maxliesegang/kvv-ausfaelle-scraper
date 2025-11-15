import type { TrainLineDefinition } from './train-line-definitions/types.js';
import { TRAIN_LINE_DEFINITIONS } from './train-line-definitions/index.js';

/**
 * Builds a mapping from train numbers to their canonical line identifiers.
 * Throws if two definitions declare the same train number for different lines.
 */
function buildTrainLineMapping(
  definitions: readonly TrainLineDefinition[],
): Readonly<Record<string, string>> {
  const map: Record<string, string> = {};

  for (const { line, trainNumbers } of definitions) {
    for (const trainNumber of trainNumbers) {
      if (map[trainNumber] && map[trainNumber] !== line) {
        throw new Error(
          `Train number ${trainNumber} already assigned to line ${map[trainNumber]} (duplicate in ${line})`,
        );
      }
      map[trainNumber] = line;
    }
  }

  return map;
}

const TRAIN_LINE_MAPPING = buildTrainLineMapping(TRAIN_LINE_DEFINITIONS);

/**
 * Returns the canonical line for a given train number, if known.
 */
export function lookupLineForTrain(trainNumber: string): string | undefined {
  return TRAIN_LINE_MAPPING[trainNumber];
}
