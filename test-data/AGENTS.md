# Fixture Data Agents

Guidance in this file applies to `test-data/**`.
This is the most specific guidance for parser fixtures.

## Structure

- HTML fixtures: `test-data/articles/`
- Expected parser output: `test-data/expected/`

## Fixture Rules

- Keep article and expected file names aligned by article id/prefix.
- Expected JSON should represent normalized parser output used in tests. Each cancellation record now includes a `cause` field (`CancellationCause`), set at article level and applied to every trip.
- Add fixtures for new format variants and regressions.
