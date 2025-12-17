import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { TrainLineDefinition } from './types.js';
import { getCurrentFahrplanYear } from '../fahrplan.js';

function loadDefinitions(fahrplanYear?: number): readonly TrainLineDefinition[] {
  const year = fahrplanYear ?? getCurrentFahrplanYear();
  if (!year) {
    throw new Error(
      'Cannot determine current Fahrplan year. ' +
        'Please update Fahrplan definitions or provide explicit year.',
    );
  }

  // Read from docs/<year>/train-line-definitions/
  const dataDir = join(process.cwd(), 'docs', String(year), 'train-line-definitions');

  if (!existsSync(dataDir)) {
    console.warn(`⚠️  No train line definitions found for Fahrplan year ${year}`);
    return [];
  }

  const files = readdirSync(dataDir)
    .filter((file) => file.endsWith('.json'))
    .sort((a, b) => a.localeCompare(b, 'en'));
  const definitions: TrainLineDefinition[] = [];

  for (const file of files) {
    const filePath = join(dataDir, file);
    const json = JSON.parse(readFileSync(filePath, 'utf-8')) as TrainLineDefinition;
    definitions.push(json);
  }

  return definitions;
}

/**
 * List of all known line-specific train mappings for the current Fahrplan year.
 * Add new definitions here by importing the corresponding file.
 */
export const TRAIN_LINE_DEFINITIONS: readonly TrainLineDefinition[] = loadDefinitions();

/**
 * Loads train line definitions for a specific Fahrplan year.
 *
 * @param fahrplanYear - The Fahrplan year to load definitions for
 * @returns Array of train line definitions for that year
 */
export function loadDefinitionsForYear(fahrplanYear: number): readonly TrainLineDefinition[] {
  return loadDefinitions(fahrplanYear);
}
