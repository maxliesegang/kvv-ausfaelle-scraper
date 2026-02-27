import assert from 'node:assert';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { generateSiteIndices } from '../../src/siteIndex.js';

interface RootIndexData {
  readonly years: readonly string[];
  readonly generatedAt: string;
}

interface YearIndexData {
  readonly year: string;
  readonly files: readonly string[];
  readonly generatedAt: string;
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, 'utf-8')) as T;
}

describe('Site index generation', () => {
  it('should generate sorted root and year indices with one timestamp per run', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'kvv-site-index-'));

    try {
      const year2025Dir = join(tempDir, '2025');
      const year2026Dir = join(tempDir, '2026');

      await mkdir(year2025Dir, { recursive: true });
      await mkdir(join(year2025Dir, 'train-line-definitions'), { recursive: true });
      await mkdir(year2026Dir, { recursive: true });

      await writeFile(join(year2025Dir, 'S2.json'), '[]\n');
      await writeFile(join(year2025Dir, 'S1.json'), '[]\n');
      await writeFile(join(year2025Dir, 'notes.txt'), 'ignore\n');
      await writeFile(join(year2026Dir, 'S5.json'), '[]\n');

      await generateSiteIndices(tempDir);

      const rootIndex = await readJsonFile<RootIndexData>(join(tempDir, 'index.json'));
      const year2025Index = await readJsonFile<YearIndexData>(join(year2025Dir, 'index.json'));
      const year2026Index = await readJsonFile<YearIndexData>(join(year2026Dir, 'index.json'));

      assert.deepStrictEqual(rootIndex.years, ['2025', '2026']);
      assert.deepStrictEqual(year2025Index.files, ['S1.json', 'S2.json']);
      assert.deepStrictEqual(year2026Index.files, ['S5.json']);
      assert.strictEqual(year2025Index.generatedAt, rootIndex.generatedAt);
      assert.strictEqual(year2026Index.generatedAt, rootIndex.generatedAt);

      const rootHtml = await readFile(join(tempDir, 'index.html'), 'utf-8');
      assert.match(rootHtml, /<a href="\.\/2025\/">2025<\/a>/);
      assert.match(rootHtml, /<a href="\.\/2026\/">2026<\/a>/);

      const yearHtml = await readFile(join(year2025Dir, 'index.html'), 'utf-8');
      assert.match(yearHtml, /<a href="\.\/S1\.json"><code>S1\.json<\/code><\/a>/);
      assert.match(yearHtml, /<a href="\.\/S2\.json"><code>S2\.json<\/code><\/a>/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
