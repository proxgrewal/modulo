import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Playwright starts the webServers before globalSetup, so the e2e data dir
 * (.modulo-data-e2e) is wiped by the API server command itself (clean-data.mjs)
 * right before it boots. Here we only make sure the API is the e2e one and
 * prepare the screenshots folder.
 */
export default async function globalSetup() {
  mkdirSync(join(process.cwd(), 'e2e', 'screenshots'), { recursive: true });
  const res = await fetch(`http://localhost:${process.env.E2E_API_PORT ?? 4100}/api/health`);
  if (!res.ok) throw new Error('e2e API server (port 4100) is not healthy');
}
