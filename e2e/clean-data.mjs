// Remove the e2e data directory (never the developer's .modulo-data).
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

const dir = resolve(process.cwd(), '.modulo-data-e2e');
if (!dir.endsWith('.modulo-data-e2e')) throw new Error(`refusing to delete ${dir}`);
for (let i = 0; i < 10; i++) {
  try {
    rmSync(dir, { recursive: true, force: true });
    break;
  } catch (e) {
    if (i === 9) console.warn(`[e2e] could not remove ${dir}: ${e.message}`);
    else await new Promise((r) => setTimeout(r, 300));
  }
}
