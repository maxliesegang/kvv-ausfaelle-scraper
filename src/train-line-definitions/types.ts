export interface TrainLineDefinition {
  readonly line: string;
  /**
   * All train numbers (Zugnummern) known for this line. Seeded in full from GTFS
   * (see `scripts/seed-train-lines-from-gtfs.ts`) — a number is kept on every line GTFS
   * runs it on. Not modified at runtime; disambiguation happens at lookup time.
   */
  readonly trainNumbers: readonly string[];
}
