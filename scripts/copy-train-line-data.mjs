import { cpSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const srcDir = join(rootDir, 'src', 'train-line-definitions', 'data');
const destDir = join(rootDir, 'dist', 'train-line-definitions', 'data');

if (!existsSync(srcDir)) {
  console.warn(`[copy-train-line-data] Source directory not found: ${srcDir}`);
  process.exit(0);
}

cpSync(srcDir, destDir, { recursive: true });
