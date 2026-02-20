#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const filePath = fileURLToPath(import.meta.url);
const packageDir = path.resolve(path.dirname(filePath), '..');
const distEntry = path.join(packageDir, 'dist', 'index.js');

if (!fs.existsSync(distEntry)) {
  process.stderr.write(
    'agent-review CLI is not built yet. Run: npm run build\n',
  );
  process.exit(1);
}

await import(pathToFileURL(distEntry).href);
