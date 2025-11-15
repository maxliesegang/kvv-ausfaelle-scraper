/**
 * Error handling and formatting utilities.
 */

/**
 * Formats an unknown error into a string message.
 * Handles Error objects and other thrown values safely.
 *
 * @param error - The error to format (can be Error, string, or any other value)
 * @returns Formatted error message string
 *
 * @example
 * try {
 *   // some operation
 * } catch (error) {
 *   console.error(`Failed: ${formatError(error)}`);
 * }
 */
export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * Wraps an error with additional context.
 *
 * @param context - Context message to prepend
 * @param error - The original error
 * @returns Formatted error message with context
 *
 * @example
 * try {
 *   await readFile(path);
 * } catch (error) {
 *   throw new Error(wrapError(`Failed to read ${path}`, error));
 * }
 */
export function wrapError(context: string, error: unknown): string {
  return `${context}: ${formatError(error)}`;
}
