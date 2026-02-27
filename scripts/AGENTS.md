# Script Agents

Guidance in this file applies to `scripts/**`.
This is the most specific guidance for maintenance scripts.

## Scope

- One-off or utility scripts that help maintain parser data and mappings.
- Scripts may read/update repository files; keep side effects explicit.

## Change Rules

- Prefer idempotent behavior where possible.
- Document expected inputs/outputs in script header comments.
- Avoid hidden writes outside intended targets.

## Required Validation

1. Run the changed script against a safe/example input.
2. `npm run type-check`
3. `npm run format:check`
