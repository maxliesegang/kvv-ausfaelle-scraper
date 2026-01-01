# Testing Guide

This directory contains all tests for the KVV Ausfälle Scraper project, organized following modern TypeScript/Node.js best practices.

## Directory Structure

```
tests/
├── unit/               # Unit tests (fast, isolated, no I/O)
│   ├── parser.test.ts
│   └── train-lines.test.ts
├── integration/        # Integration tests (may modify files, slower)
│   └── fallback-matching.test.ts
├── helpers/            # Shared test utilities
│   ├── test-utils.ts
│   └── fixture-loader.ts
├── fixtures/           # Test fixtures (if needed)
└── README.md           # This file
```

## Running Tests

### All Tests

```bash
npm test
```

Runs all unit and integration tests.

### Unit Tests Only

```bash
npm run test:unit
```

Runs only unit tests (fast, safe, no file modifications).

### Integration Tests Only

```bash
npm run test:integration
```

Runs integration tests (may modify files).

### Specific Test Files

```bash
# Parser tests
npm run test:parser

# Train lines tests
npm run test:train-lines

# Fallback matching (WARNING: modifies files)
npm run test:fallback <trainNumber>
```

### Watch Mode

```bash
npm run test:watch
```

Watches for file changes and re-runs tests automatically.

## Test Framework

We use **Node.js built-in test runner** (`node:test` module) because:

- ✅ No additional dependencies
- ✅ Fast and lightweight
- ✅ Built into Node 18+
- ✅ Full TypeScript support via `tsx`
- ✅ Modern features (describe, it, mock, etc.)

## Writing Tests

### Basic Test Structure

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert';

describe('Feature Name', () => {
  it('should do something', () => {
    const result = myFunction();
    assert.strictEqual(result, expected);
  });
});
```

### Using Shared Utilities

```typescript
import { assertCancellationsEqual, assertThrows } from '../helpers/test-utils.js';
import { loadFixture } from '../helpers/fixture-loader.js';

describe('Parser', () => {
  it('should parse article', () => {
    const fixture = loadFixture('article-123');
    const result = parseDetailPage(fixture.html, 'test://url');
    assertCancellationsEqual(result, fixture.expected);
  });
});
```

### Test Organization

**Unit Tests** (`tests/unit/`)

- Test individual functions in isolation
- Mock external dependencies
- Fast execution (< 1s total)
- No file system modifications
- No network requests

**Integration Tests** (`tests/integration/`)

- Test complete workflows
- May interact with file system
- May modify data files
- Slower execution
- Test real-world scenarios

## Shared Test Utilities

### `test-utils.ts`

**`normalizeCancellation(cancellation)`**

- Removes dynamic fields (sourceUrl, capturedAt)
- Use for comparing test results

**`assertCancellationsEqual(actual, expected, message?)`**

- Deep comparison with detailed error messages
- Automatically normalizes cancellations

**`assertThrows(fn, pattern, message?)`**

- Asserts function throws matching error
- Supports string or RegExp pattern

**`assertSorted(array, comparator, message?)`**

- Verifies array is sorted
- Custom comparator function

### `fixture-loader.ts`

**`loadFixture(name)`**

- Loads HTML and expected JSON for a test
- Returns `{ name, html, expected, htmlPath, expectedPath }`

**`loadAllFixtures()`**

- Loads all test fixtures from `test-data/`
- Returns array of fixtures

## Test Data

Test data is organized in `test-data/`:

```
test-data/
├── articles/     # HTML files (input)
│   └── article-*.html
└── expected/     # JSON files (expected output)
    └── article-*.json
```

### Adding New Test Cases

1. **Save HTML file**

   ```bash
   npm run fetch-article <articleId>
   ```

2. **Create expected output**
   - Run parser manually
   - Verify output is correct
   - Save to `test-data/expected/article-<id>.json`

3. **Tests automatically discover new fixtures**
   - No code changes needed
   - Run `npm test` to verify

## Best Practices

### ✅ DO

- Write descriptive test names
- Test one thing per test
- Use shared utilities for common operations
- Add comments for complex test logic
- Keep tests fast and focused
- Test both happy path and error cases

### ❌ DON'T

- Don't duplicate test utilities
- Don't test implementation details
- Don't make tests depend on each other
- Don't commit failing tests
- Don't skip tests without good reason
- Don't modify production code just for tests

## Examples

### Testing Parser

```typescript
import { describe, it } from 'node:test';
import { parseDetailPage } from '../../src/parser/index.js';
import { loadFixture } from '../helpers/fixture-loader.js';
import { assertCancellationsEqual } from '../helpers/test-utils.js';

describe('Parser', () => {
  it('should parse S1 article', () => {
    const fixture = loadFixture('article-256933-real-s5');
    const result = parseDetailPage(fixture.html, 'test://test');
    assertCancellationsEqual(result, fixture.expected);
  });
});
```

### Testing Train Lines

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { lookupLineForTrain } from '../../src/train-lines.js';

describe('Train Lines', () => {
  it('should return correct line', () => {
    const result = lookupLineForTrain('10001');
    assert.strictEqual(result, 'S1');
  });
});
```

### Testing Error Handling

```typescript
import { assertThrows } from '../helpers/test-utils.js';

describe('Error Handling', () => {
  it('should throw on invalid input', () => {
    assertThrows(() => parseDetailPage('', 'test://empty'), 'Incorrect parse');
  });
});
```

## Continuous Integration

Tests run automatically on:

- Every push to main
- Every pull request
- Before deployment

### CI Requirements

- All tests must pass
- TypeScript must compile
- Code must be formatted (Prettier)

## Troubleshooting

### Tests fail locally but pass in CI

- Clear node_modules and reinstall
- Check Node.js version (>= 18.0.0)
- Verify test-data files exist

### Tests are slow

- Run only unit tests: `npm run test:unit`
- Use watch mode: `npm run test:watch`
- Check for unnecessary file I/O

### TypeScript errors in tests

- Ensure tsx is installed: `npm install`
- Check tsconfig.json includes tests
- Verify imports use .js extension

## Resources

- [Node.js Test Runner](https://nodejs.org/api/test.html)
- [Node.js Assert API](https://nodejs.org/api/assert.html)
- [TypeScript Testing Best Practices](https://typescript-eslint.io/docs/linting/troubleshooting/)

## Questions?

Check the main [README.md](../README.md) or open an issue.
