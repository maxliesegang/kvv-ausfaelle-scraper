# Agents

This repository uses path-scoped `AGENTS.md` files to minimize context.
When multiple files apply, use the closest file to the edited path as the most specific guidance.

## Global Scope

- Project goal: scrape KVV cancellation-style notices, extract structured trip cancellation data, and publish generated artifacts under `docs/`.
- Data model rule: cancellation data and train-line definitions are organized by **Fahrplan year**, not calendar year.
- Primary commands:
  - `npm run dev`
  - `npm run test:unit`
  - `npm run type-check`
  - `npm run format:check`

## Path Map

- `/.github/AGENTS.md` - GitHub-level automation and monitoring context.
- `/.github/workflows/AGENTS.md` - workflow schedule, behavior, permissions.
- `/src/AGENTS.md` - scraper pipeline, parsing/relevance architecture, runtime config.
- `/src/parser/AGENTS.md` - parser extraction rules, patterns, and regression checks.
- `/src/train-line-definitions/AGENTS.md` - train-number mapping and Fahrplan-year definition handling.
- `/scripts/AGENTS.md` - one-off data/script maintenance guidance.
- `/docs/AGENTS.md` - published output layout and generated artifact expectations.
- `/tests/AGENTS.md` - test structure and expectations for code changes.
- `/test-data/AGENTS.md` - fixture conventions for parser coverage.
