/**
 * Service entry point: reads `PORT` (default 8080) and starts the HTTP server.
 */

import { createServer } from './server.js';

const DEFAULT_PORT = 8080;

function resolvePort(): number {
  const raw = process.env['PORT'];
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_PORT;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`[library] invalid PORT "${raw}", falling back to ${DEFAULT_PORT}`);
    return DEFAULT_PORT;
  }
  return port;
}

const port = resolvePort();
const { server } = createServer();

server.listen(port, () => {
  console.log(`[library] listening on http://localhost:${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`[library] ${signal} received, shutting down`);
    server.close(() => process.exit(0));
    // Do not wait forever for keep-alive connections.
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
