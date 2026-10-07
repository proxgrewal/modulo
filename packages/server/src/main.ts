import { join } from 'node:path';
import { serve } from '@hono/node-server';
import type { Server } from 'node:http';
import { bootKernel, REPO_ROOT } from './boot.ts';
import { createApp } from './app.ts';
import { attachCollab } from './collab.ts';
import { storageFromEnv } from './storage.ts';

const port = Number(process.env.PORT ?? 4000);
const dataDir = process.env.MODULO_DATA ?? join(REPO_ROOT, '.modulo-data');

const kernel = await bootKernel({ databaseUrl: process.env.DATABASE_URL ?? join(dataDir, 'pglite'), log: (m, e) => console.log(`[kernel] ${m}`, e ?? '') });
const { app, cache } = createApp({
  kernel,
  storage: storageFromEnv(join(dataDir, 'media')),
  editorDist: join(REPO_ROOT, 'apps', 'editor', 'dist'),
  openSignup: process.env.MODULO_OPEN_SIGNUP !== '0',
  secureCookies: process.env.MODULO_SECURE_COOKIES === '1',
});
kernel.startWorker(500);

const server = serve({ fetch: app.fetch, port }) as unknown as Server;
const collab = attachCollab(server, kernel, { cache });

const n = kernel.catalog.names().length;
console.log(`Modulo kernel ${kernel.version} · ${n} modules · http://localhost:${port}`);
console.log(`Editor: http://localhost:5173 (dev) or http://localhost:${port}/_editor/ (built)`);

const shutdown = async () => {
  await collab.flush();
  collab.close();
  await kernel.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
