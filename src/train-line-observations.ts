import { join } from 'node:path';
import { exists, ensureDirectory, readJsonFile, writeJsonFile } from './utils/fs.js';
import { normalizeLine, normalizeTrainNumber } from './utils/normalization.js';

const TRAIN_LINE_DATA_DIR = join(process.cwd(), 'src', 'train-line-definitions', 'data');

/**
 * Map from line identifier to set of train numbers observed for that line.
 */
export type TrainLineObservations = Map<string, Set<string>>;

/**
 * Creates a helper that records observed line/train-number pairs.
 */
export function createTrainLineObservationRecorder(): {
  readonly observations: TrainLineObservations;
  readonly record: (line: string, trainNumber: string) => void;
} {
  const observations: TrainLineObservations = new Map();

  const record = (line: string, trainNumber: string): void => {
    const normalizedLine = normalizeLine(line);
    const normalizedTrainNum = normalizeTrainNumber(trainNumber);
    if (!normalizedLine || !normalizedTrainNum) {
      return;
    }

    if (!observations.has(normalizedLine)) {
      observations.set(normalizedLine, new Set());
    }

    observations.get(normalizedLine)!.add(normalizedTrainNum);
  };

  return { observations, record };
}

interface LineDefinition {
  readonly line: string;
  readonly trainNumbers: string[];
}

function slugifyLineId(line: string): string {
  return line
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Loads an existing train line definition from disk.
 * Returns a default empty definition if the file doesn't exist.
 */
async function loadExistingLineDefinition(
  filePath: string,
  line: string,
): Promise<LineDefinition | null> {
  if (!(await exists(filePath))) {
    return { line, trainNumbers: [] };
  }

  try {
    const data = await readJsonFile<LineDefinition>(filePath);
    return data || { line, trainNumbers: [] };
  } catch (error) {
    console.warn(`⚠️  Failed to read ${filePath}:`, error);
    return null;
  }
}

/**
 * Merges new train numbers with existing ones.
 * Returns the newly added train numbers and the complete merged set.
 */
function mergeTrainNumbers(
  existing: readonly string[],
  newNumbers: Set<string>,
): { merged: string[]; newlyAdded: string[] } {
  const mergedSet = new Set(existing);
  const newlyAdded: string[] = [];

  for (const trainNumber of newNumbers) {
    if (!mergedSet.has(trainNumber)) {
      mergedSet.add(trainNumber);
      newlyAdded.push(trainNumber);
    }
  }

  const merged = Array.from(mergedSet).sort((a, b) => a.localeCompare(b, 'de', { numeric: true }));
  return { merged, newlyAdded };
}

/**
 * Persists observed train line mappings into the data directory.
 */
export async function updateTrainLineDefinitionsFromObservations(
  observations: TrainLineObservations,
): Promise<void> {
  if (observations.size === 0) {
    return;
  }

  await ensureDirectory(TRAIN_LINE_DATA_DIR);

  for (const [line, trainNumbers] of observations) {
    if (trainNumbers.size === 0) continue;

    const slug = slugifyLineId(line);
    if (!slug) continue;

    const filePath = join(TRAIN_LINE_DATA_DIR, `${slug}.json`);
    const existing = await loadExistingLineDefinition(filePath, line);

    if (!existing) continue; // Failed to load, skip this line

    // Validate line consistency
    if (existing.line && existing.line !== line) {
      console.warn(
        `⚠️  Skipping train line update for ${line} because ${filePath} already defines ${existing.line}`,
      );
      continue;
    }

    // Merge train numbers
    const { merged, newlyAdded } = mergeTrainNumbers(existing.trainNumbers, trainNumbers);

    if (newlyAdded.length === 0) {
      continue; // No new train numbers to add
    }

    // Save updated definition
    const updated: LineDefinition = { line, trainNumbers: merged };
    await writeJsonFile(filePath, updated);
    console.log(`  ↳ Added ${newlyAdded.join(', ')} to train-line mapping (${line} → ${filePath})`);
  }
}
