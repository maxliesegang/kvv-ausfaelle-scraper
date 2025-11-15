import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createTrainLineObservationRecorder,
  updateTrainLineDefinitionsFromObservations,
} from '../src/train-line-observations.js';

const expectedDir = join(process.cwd(), 'test-data', 'expected');

function extractFromTestData(): void {
  const files = readdirSync(expectedDir).filter((file) => file.endsWith('.json'));
  if (files.length === 0) {
    console.log('No test data files found in', expectedDir);
    return;
  }

  const { observations, record } = createTrainLineObservationRecorder();
  let processedEntries = 0;

  for (const file of files) {
    const filePath = join(expectedDir, file);
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(filePath, 'utf-8'));
    } catch (error) {
      console.warn(
        `Skipping ${file}: failed to parse JSON (${error instanceof Error ? error.message : error})`,
      );
      continue;
    }

    if (!Array.isArray(data)) {
      continue;
    }

    for (const entry of data) {
      if (!entry || typeof entry !== 'object') continue;

      const line =
        typeof (entry as any).line === 'string' ? (entry as any).line.trim().toUpperCase() : '';
      const trainNumberRaw = (entry as any).trainNumber;
      const trainNumber =
        typeof trainNumberRaw === 'string'
          ? trainNumberRaw.trim()
          : typeof trainNumberRaw === 'number'
            ? String(trainNumberRaw)
            : '';

      if (!line || line === 'UNKNOWN') continue;
      if (!trainNumber) continue;

      record(line, trainNumber);
      processedEntries++;
    }
  }

  if (processedEntries === 0) {
    console.log('No usable entries found in test data.');
    return;
  }

  updateTrainLineDefinitionsFromObservations(observations);
  console.log(
    `Updated train line definitions using ${processedEntries} entries from ${files.length} test files.`,
  );
}

extractFromTestData();
