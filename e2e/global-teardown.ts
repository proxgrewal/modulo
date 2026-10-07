import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

const DIR = resolve(process.cwd(), '.modulo-data-e2e');

function clean(): boolean {
  try {
    rmSync(DIR, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Delete the e2e data dir. Teardown runs before Playwright stops the
 * webServers, so files may still be locked (Windows): retry once the
 * runner process exits, after the servers are gone.
 */
export default async function globalTeardown() {
  if (!DIR.endsWith('.modulo-data-e2e')) return;
  if (clean()) return;
  process.on('exit', () => {
    for (let i = 0; i < 20 && !clean(); i++) {
      const until = Date.now() + 150;
      while (Date.now() < until) {
        /* brief sync wait for file handles to close */
      }
    }
  });
}
