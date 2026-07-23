import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { parseArchive } from '../../src/article-archive.js';
import { parseDetailPage } from '../../src/parser/index.js';

const DOCS_DIR = join(process.cwd(), 'docs');
const CLOCK_TIME_PATTERN = /\b(\d{1,2}:\d{2})\b/g;
const TRAIN_NUMBER_PATTERN = /\b(\d{4,6})\b/g;
const NUMBERED_ROW_PATTERN = /^\s*(?:(?:[A-Za-z]+\d+)\s+)?(\d{4,6})\b/;

interface ArchivedTripOccurrence {
  filePath: string;
  lineNumber: number;
  trainNumber: string;
  fromTime?: string;
  toTime?: string;
}

interface ArchiveCorpusAudit {
  knownTrainOccurrences: ArchivedTripOccurrence[];
  numberedRowOccurrences: ArchivedTripOccurrence[];
  knownTrainProblems: string[];
  numberedRowProblems: string[];
}

function createTripSignature(trainNumber: string, fromTime: string, toTime: string): string {
  return `${trainNumber}|${fromTime}|${toTime}`;
}

function loadKnownTrainNumbers(yearDirectory: string): Set<string> {
  const definitionsDirectory = join(yearDirectory, 'train-line-definitions');
  const knownTrainNumbers = new Set<string>();

  if (!existsSync(definitionsDirectory)) {
    return knownTrainNumbers;
  }

  for (const filename of readdirSync(definitionsDirectory)) {
    if (!filename.endsWith('.json') || filename === 'ambiguous-trips.json') {
      continue;
    }

    const definition = JSON.parse(readFileSync(join(definitionsDirectory, filename), 'utf8')) as {
      trainNumbers?: string[];
    };

    for (const trainNumber of definition.trainNumbers ?? []) {
      knownTrainNumbers.add(trainNumber);
    }
  }

  return knownTrainNumbers;
}

function createArchivedTripOccurrence(
  filePath: string,
  lineNumber: number,
  line: string,
  trainNumber: string,
  times: string[],
): ArchivedTripOccurrence {
  const endpointTimes =
    times.length < 2
      ? []
      : /\bentfällt\s+zwischen\b/i.test(line)
        ? times.slice(0, 2)
        : [times[0], times.at(-1)!];

  return {
    filePath,
    lineNumber,
    trainNumber,
    fromTime: endpointTimes[0],
    toTime: endpointTimes[1],
  };
}

function auditArchiveCorpus(): ArchiveCorpusAudit {
  const auditResult: ArchiveCorpusAudit = {
    knownTrainOccurrences: [],
    numberedRowOccurrences: [],
    knownTrainProblems: [],
    numberedRowProblems: [],
  };

  for (const yearEntry of readdirSync(DOCS_DIR, { withFileTypes: true })) {
    if (!yearEntry.isDirectory() || !/^\d{4}$/.test(yearEntry.name)) {
      continue;
    }

    const yearDirectory = join(DOCS_DIR, yearEntry.name);
    const articlesDirectory = join(yearDirectory, 'articles');
    if (!existsSync(articlesDirectory)) {
      continue;
    }

    const knownTrainNumbers = loadKnownTrainNumbers(yearDirectory);

    for (const filename of readdirSync(articlesDirectory)) {
      if (!filename.endsWith('.txt')) {
        continue;
      }

      const filePath = join(articlesDirectory, filename);
      const archivedArticle = parseArchive(readFileSync(filePath, 'utf8'));
      const parsedTripSignatures = new Set<string>();
      const parsedTrainNumbers = new Set<string>();
      let parsingError: unknown;

      try {
        for (const trip of parseDetailPage(archivedArticle.body, archivedArticle.url)) {
          parsedTrainNumbers.add(trip.trainNumber);
          parsedTripSignatures.add(
            createTripSignature(trip.trainNumber, trip.fromTime, trip.toTime),
          );
        }
      } catch (error) {
        parsingError = error;
      }

      for (const [index, line] of archivedArticle.body.split('\n').entries()) {
        const times = [...line.matchAll(CLOCK_TIME_PATTERN)].map((match) => match[1]);

        const lineNumber = index + 1;
        const trainNumbers = [...line.matchAll(TRAIN_NUMBER_PATTERN)].map((match) => match[1]);

        for (const trainNumber of new Set(trainNumbers)) {
          if (!knownTrainNumbers.has(trainNumber)) {
            continue;
          }

          const occurrence = createArchivedTripOccurrence(
            filePath,
            lineNumber,
            line,
            trainNumber,
            times,
          );
          auditResult.knownTrainOccurrences.push(occurrence);
          const expectedSignature =
            occurrence.fromTime && occurrence.toTime
              ? createTripSignature(occurrence.trainNumber, occurrence.fromTime, occurrence.toTime)
              : undefined;

          if (
            parsingError ||
            !parsedTrainNumbers.has(occurrence.trainNumber) ||
            (expectedSignature && !parsedTripSignatures.has(expectedSignature))
          ) {
            auditResult.knownTrainProblems.push(
              `${filePath}:${lineNumber}: expected GTFS trip ` +
                `${expectedSignature ?? occurrence.trainNumber}` +
                (parsingError ? `; parser failed: ${String(parsingError)}` : ''),
            );
          }
        }

        const numberedRow = line.match(NUMBERED_ROW_PATTERN);
        if (!numberedRow) {
          continue;
        }

        const occurrence = createArchivedTripOccurrence(
          filePath,
          lineNumber,
          line,
          numberedRow[1],
          times,
        );
        auditResult.numberedRowOccurrences.push(occurrence);
        const expectedSignature =
          occurrence.fromTime && occurrence.toTime
            ? createTripSignature(occurrence.trainNumber, occurrence.fromTime, occurrence.toTime)
            : undefined;

        if (
          parsingError ||
          !parsedTrainNumbers.has(occurrence.trainNumber) ||
          (expectedSignature && !parsedTripSignatures.has(expectedSignature))
        ) {
          auditResult.numberedRowProblems.push(
            `${filePath}:${lineNumber}: expected numbered trip ` +
              `${expectedSignature ?? occurrence.trainNumber}` +
              (parsingError ? `; parser failed: ${String(parsingError)}` : ''),
          );
        }
      }
    }
  }

  return auditResult;
}

describe('preserved article corpus', () => {
  const auditResult = auditArchiveCorpus();

  test('parses every GTFS-known trip occurrence with its endpoint times', () => {
    assert.ok(
      auditResult.knownTrainOccurrences.length > 0,
      'expected the archive corpus to contain GTFS-known trip occurrences',
    );
    assert.deepEqual(auditResult.knownTrainProblems, []);
  });

  test('parses every explicit numbered trip row, including GTFS gaps', () => {
    assert.ok(
      auditResult.numberedRowOccurrences.length >= 320,
      `expected at least 320 numbered rows, found ${auditResult.numberedRowOccurrences.length}`,
    );
    assert.deepEqual(auditResult.numberedRowProblems, []);
  });
});
