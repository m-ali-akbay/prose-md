import type { AddressInfo } from 'node:net';
import * as http from 'node:http';

import { createServer } from '../src/server.js';
import type { Library } from '../src/library.js';

export interface ApiResponse {
  status: number;
  // Tests read API payloads ergonomically; `any` keeps assertions short.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

export interface TestServer {
  url: string;
  library: Library;
  request(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<ApiResponse>;
  close(): Promise<void>;
}

/** Start the service on an ephemeral port bound to the loopback interface. */
export async function startServer(): Promise<TestServer> {
  const { server, library } = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}`;

  return {
    url,
    library,
    async request(method, path, body, headers) {
      const requestHeaders: Record<string, string> = { ...headers };
      const init: RequestInit = { method, headers: requestHeaders };
      if (body !== undefined) {
        requestHeaders['content-type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
      const response = await fetch(`${url}${path}`, init);
      const text = await response.text();
      return {
        status: response.status,
        body: text === '' ? null : (JSON.parse(text) as unknown),
      };
    },
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        // Drop keep-alive sockets opened by fetch so close() cannot hang.
        (server as http.Server).closeAllConnections?.();
      });
    },
  };
}

/** ISO timestamp `days` after `from`, used to drive `X-Fake-Now`. */
export function isoAfter(from: string, days: number): string {
  return new Date(new Date(from).getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}
