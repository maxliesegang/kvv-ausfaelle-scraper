export interface TrainLineDefinition {
  readonly line: string;
  readonly trainNumbers: readonly string[];
  /**
   * Optional list of lines that share train numbers with this line.
   * This is used to resolve cases where trains continue on a different line.
   */
  readonly connectedLines?: readonly string[];
}
