# Fixture Data Agents

Guidance in this file applies to `test-data/**`.
This is the most specific guidance for parser fixtures.

## Structure

- HTML fixtures: `test-data/articles/`
- Expected parser output: `test-data/expected/`

## Fixture Rules

- Keep article and expected file names aligned by article id/prefix.
- Expected JSON represents the partial `Cancellation` shape asserted by parser tests. Include the
  article-level `cause`; include `causeKeyword` when the fixture is intended to assert classifier
  evidence. Newly generated fixtures include both.
- Add fixtures for previously unseen parser layouts and regressions.
