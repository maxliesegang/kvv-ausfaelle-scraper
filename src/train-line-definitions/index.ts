import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TrainLineDefinition } from './types.js';

function loadDefinitions(): readonly TrainLineDefinition[] {
  const dataDir = fileURLToPath(new URL('./data', import.meta.url));
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
 * List of all known line-specific train mappings.
 * Add new definitions here by importing the corresponding file.
 */
export const TRAIN_LINE_DEFINITIONS: readonly TrainLineDefinition[] = loadDefinitions();
