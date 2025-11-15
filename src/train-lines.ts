import type { TrainLineDefinition } from './train-line-definitions/types.js';
import { TRAIN_LINE_DEFINITIONS } from './train-line-definitions/index.js';
import { normalizeLine, normalizeLines } from './utils/normalization.js';

interface TrainLineMappingEntry {
  readonly primaryLine: string;
  readonly lines: readonly string[];
}

type LineConnections = Map<string, Set<string>>;
type TrainLineMapping = Readonly<Record<string, TrainLineMappingEntry>>;

function ensureLineConnection(connections: LineConnections, line: string): Set<string> {
  if (!connections.has(line)) {
    connections.set(line, new Set());
  }
  return connections.get(line)!;
}

function buildLineConnections(definitions: readonly TrainLineDefinition[]): LineConnections {
  const connections: LineConnections = new Map();

  for (const { line, connectedLines } of definitions) {
    const normalizedLine = normalizeLine(line);
    if (!normalizedLine) continue;

    const current = ensureLineConnection(connections, normalizedLine);

    for (const connected of connectedLines ?? []) {
      const normalizedConnected = normalizeLine(connected);
      if (!normalizedConnected) continue;
      current.add(normalizedConnected);
      ensureLineConnection(connections, normalizedConnected).add(normalizedLine);
    }
  }

  return connections;
}

/**
 * Builds a mapping from train numbers to their canonical line identifiers.
 * Allows duplicates when lines declare a connection via connectedLines.
 */
function buildTrainLineMapping(definitions: readonly TrainLineDefinition[]): TrainLineMapping {
  const connections = buildLineConnections(definitions);
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

      const isConnected = existing.lines.some((existingLine) =>
        connections.get(existingLine)?.has(line),
      );

      if (!isConnected) {
        throw new Error(
          `Train number ${trainNumber} already assigned to line ${existing.primaryLine} (duplicate in ${line})`,
        );
      }

      existing.lines.push(line);
    }
  }

  return map;
}

const LINE_CONNECTIONS = buildLineConnections(TRAIN_LINE_DEFINITIONS);
const TRAIN_LINE_MAPPING = buildTrainLineMapping(TRAIN_LINE_DEFINITIONS);

/**
 * Checks if a line is valid within the context of mentioned lines.
 * A line is valid if it's one of the mentioned lines or connected to any of them.
 */
export function isLineValidForMentionedLines(
  line: string,
  mentionedLines: readonly string[],
): boolean {
  const normalizedLine = normalizeLine(line);
  if (!normalizedLine) return false;

  const normalizedMentioned = normalizeLines(mentionedLines);

  // Check if it's directly mentioned
  if (normalizedMentioned.includes(normalizedLine)) {
    return true;
  }

  // Check if it's connected to any mentioned line
  const connections = LINE_CONNECTIONS.get(normalizedLine);
  if (!connections) return false;

  return normalizedMentioned.some((mentioned) => connections.has(mentioned));
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
