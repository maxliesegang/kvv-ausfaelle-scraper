# Train Line Definition Agents

Guidance in this file applies to `src/train-line-definitions/**`.
This is the most specific guidance for train-line definition source files.

## Scope

This area defines and loads train-number to line mappings used during parsing.

## Core Rules

- Mapping versions are tied to Fahrplan years.
- Runtime definitions are expected under `docs/<fahrplan-year>/train-line-definitions/`.
- Train numbers may change between Fahrplan years, so avoid cross-year assumptions.

## Fahrplan Year Maintenance

When a new Fahrplan period is introduced:

1. Update year boundaries in `src/fahrplan.ts`.
2. Create `docs/<new-year>/train-line-definitions/`.
3. Optionally seed from previous year and then adjust.

If a date is outside known Fahrplan periods, the scraper should fail with a clear message prompting update of `src/fahrplan.ts`.
