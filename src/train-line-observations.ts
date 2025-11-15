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

function slugifyLineId(line: string): string {
  return line
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
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
    let existing: { line: string; trainNumbers: string[] } = { line, trainNumbers: [] };

    if (await exists(filePath)) {
      try {
        const data = await readJsonFile<{ line: string; trainNumbers: string[] }>(filePath);
        if (data) {
          existing = data;
        }
      } catch (error) {
        console.warn(`⚠️  Failed to read ${filePath}:`, error);
        continue;
      }
    }

    if (existing.line && existing.line !== line) {
      console.warn(
        `⚠️  Skipping train line update for ${line} because ${filePath} already defines ${existing.line}`,
      );
      continue;
    }

    const merged = new Set(existing.trainNumbers ?? []);
    const newlyAdded: string[] = [];
    for (const trainNumber of trainNumbers) {
      if (!merged.has(trainNumber)) {
        merged.add(trainNumber);
        newlyAdded.push(trainNumber);
      }
    }

    if (newlyAdded.length === 0) {
      continue;
    }

    const updated = {
      line,
      trainNumbers: Array.from(merged).sort((a, b) => a.localeCompare(b, 'de', { numeric: true })),
    };

    await writeJsonFile(filePath, updated);
    console.log(`  ↳ Added ${newlyAdded.join(', ')} to train-line mapping (${line} → ${filePath})`);
  }
}
