/**
 * HTTP layer: plain `node:http`, manual routing, JSON in and JSON out.
 *
 * Every request resolves its own "now" from the `X-Fake-Now` header before the
 * domain layer is called, so time travels per request.
 */

import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer as nodeCreateServer } from 'node:http';

import { resolveNow } from './clock.js';
import { HttpError, badRequest, methodNotAllowed, notFound } from './errors.js';
import { Library, type BookFilter, type LoanFilter, type LoanStatus } from './library.js';
import { readQueryString } from './validate.js';

export interface LibraryServer {
  server: Server;
  library: Library;
}

const MAX_BODY_BYTES = 1_000_000;
const LOAN_STATUSES: readonly LoanStatus[] = ['active', 'overdue', 'returned'];

export function createServer(library: Library = new Library()): LibraryServer {
  const server = nodeCreateServer((req, res) => {
    void handleRequest(library, req, res);
  });
  return { server, library };
}

async function handleRequest(library: Library, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    await dispatch(library, req, res);
  } catch (error) {
    sendError(res, error);
  }
}

async function dispatch(
  library: Library,
  req: IncomingMessage,
  res: ServerResponse,
  now = resolveNow(req.headers['x-fake-now']),
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const method = (req.method ?? 'GET').toUpperCase();
  const segments = url.pathname
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => decodeURIComponent(segment));

  const head = segments[0];
  const rest = segments.slice(1);

  if (head === undefined) {
    allow(method, ['GET']);
    json(res, 200, {
      service: 'library',
      status: 'ok',
      resources: ['/health', '/books', '/members', '/loans', '/members/:id/fines'],
    });
    return;
  }

  if (head === 'health') {
    allow(method, ['GET']);
    json(res, 200, { status: 'ok' });
    return;
  }

  if (head === 'books') {
    await handleBooks(library, req, res, method, rest, url.searchParams);
    return;
  }

  if (head === 'members') {
    await handleMembers(library, req, res, method, rest, now);
    return;
  }

  if (head === 'loans') {
    await handleLoans(library, req, res, method, rest, url.searchParams, now);
    return;
  }

  throw notFound(`Unknown resource "/${head}"`);
}

/* ------------------------------------------------------------------ books */

async function handleBooks(
  library: Library,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  rest: string[],
  query: URLSearchParams,
): Promise<void> {
  if (rest.length === 0) {
    if (method === 'GET') {
      const filter: BookFilter = {
        q: readQueryString(query.get('q'), 'q'),
        title: readQueryString(query.get('title'), 'title'),
        author: readQueryString(query.get('author'), 'author'),
        isbn: readQueryString(query.get('isbn'), 'isbn'),
        tag: readQueryString(query.get('tag'), 'tag'),
      };
      json(res, 200, { books: library.listBooks(filter) });
      return;
    }
    if (method === 'POST') {
      const body = await readJsonBody(req);
      const { book, created } = library.addBook(body);
      json(res, created ? 201 : 200, book);
      return;
    }
    throw methodNotAllowed(method, ['GET', 'POST']);
  }

  if (rest.length === 1) {
    const bookId = rest[0] as string;
    if (method === 'GET') {
      json(res, 200, library.getBook(bookId));
      return;
    }
    if (method === 'DELETE') {
      library.removeBook(bookId);
      res.writeHead(204).end();
      return;
    }
    throw methodNotAllowed(method, ['GET', 'DELETE']);
  }

  throw notFound(`Unknown book resource "/books/${rest.join('/')}"`);
}

/* ---------------------------------------------------------------- members */

async function handleMembers(
  library: Library,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  rest: string[],
  now: Date,
): Promise<void> {
  if (rest.length === 0) {
    if (method === 'GET') {
      json(res, 200, { members: library.listMembers(now) });
      return;
    }
    if (method === 'POST') {
      const body = await readJsonBody(req);
      json(res, 201, library.registerMember(body, now));
      return;
    }
    throw methodNotAllowed(method, ['GET', 'POST']);
  }

  const memberId = rest[0] as string;

  if (rest.length === 1) {
    if (method === 'GET') {
      json(res, 200, library.getMember(memberId, now));
      return;
    }
    throw methodNotAllowed(method, ['GET']);
  }

  if (rest.length === 2) {
    const action = rest[1];
    if (action === 'loans') {
      if (method !== 'GET') throw methodNotAllowed(method, ['GET']);
      json(res, 200, { loans: library.loanHistory(memberId, now) });
      return;
    }
    if (action === 'suspend') {
      if (method !== 'POST') throw methodNotAllowed(method, ['POST']);
      const body = await readJsonBody(req, true);
      json(res, 200, library.suspendMember(memberId, body, now));
      return;
    }
    if (action === 'unsuspend') {
      if (method !== 'POST') throw methodNotAllowed(method, ['POST']);
      await readJsonBody(req, true);
      json(res, 200, library.unsuspendMember(memberId, now));
      return;
    }
    if (action === 'fines') {
      if (method !== 'GET') throw methodNotAllowed(method, ['GET']);
      json(res, 200, library.fines(memberId, now));
      return;
    }
  }

  if (rest.length === 3 && rest[1] === 'fines' && rest[2] === 'pay') {
    if (method !== 'POST') throw methodNotAllowed(method, ['POST']);
    const body = await readJsonBody(req, true);
    json(res, 200, library.payFines(memberId, body, now));
    return;
  }

  throw notFound(`Unknown member resource "/members/${rest.join('/')}"`);
}

/* ------------------------------------------------------------------ loans */

async function handleLoans(
  library: Library,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  rest: string[],
  query: URLSearchParams,
  now: Date,
): Promise<void> {
  if (rest.length === 0) {
    if (method === 'GET') {
      const status = readQueryString(query.get('status'), 'status');
      if (status !== undefined && !LOAN_STATUSES.includes(status as LoanStatus)) {
        throw badRequest(`Query parameter "status" must be one of: ${LOAN_STATUSES.join(', ')}`);
      }
      const filter: LoanFilter = {
        memberId: readQueryString(query.get('memberId'), 'memberId'),
        bookId: readQueryString(query.get('bookId'), 'bookId'),
        status: status as LoanStatus | undefined,
      };
      json(res, 200, { loans: library.listLoans(filter, now) });
      return;
    }
    if (method === 'POST') {
      const body = await readJsonBody(req);
      json(res, 201, library.borrowBook(body, now));
      return;
    }
    throw methodNotAllowed(method, ['GET', 'POST']);
  }

  if (rest.length === 1 && rest[0] === 'overdue') {
    if (method !== 'GET') throw methodNotAllowed(method, ['GET']);
    json(res, 200, { loans: library.overdueLoans(now) });
    return;
  }

  const loanId = rest[0] as string;

  if (rest.length === 1) {
    if (method === 'GET') {
      const loan = library.listLoans({}, now).find((candidate) => candidate.id === loanId);
      if (loan === undefined) throw notFound(`Loan ${loanId} was not found`);
      json(res, 200, loan);
      return;
    }
    throw methodNotAllowed(method, ['GET']);
  }

  if (rest.length === 2) {
    const action = rest[1];
    if (action === 'return') {
      if (method !== 'POST') throw methodNotAllowed(method, ['POST']);
      await readJsonBody(req, true);
      json(res, 200, library.returnLoan(loanId, now));
      return;
    }
    if (action === 'renew') {
      if (method !== 'POST') throw methodNotAllowed(method, ['POST']);
      await readJsonBody(req, true);
      json(res, 200, library.renewLoan(loanId, now));
      return;
    }
  }

  throw notFound(`Unknown loan resource "/loans/${rest.join('/')}"`);
}

/* ------------------------------------------------------------------ utils */

function allow(method: string, allowed: readonly string[]): void {
  if (!allowed.includes(method)) {
    throw methodNotAllowed(method, allowed);
  }
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res: ServerResponse, error: unknown): void {
  if (error instanceof HttpError) {
    json(res, error.status, { error: error.message, code: error.code });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  console.error('[library] unexpected error:', message);
  json(res, 500, { error: 'Internal server error', code: 'INTERNAL_ERROR' });
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Request body must be at most 1MB');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Read a JSON object body. An empty body yields `undefined` when `optional`
 * is set (handy for actions such as `return`, which take no payload).
 */
async function readJsonBody(req: IncomingMessage, optional = false): Promise<Record<string, unknown> | undefined> {
  const raw = await readBody(req);
  if (raw.trim() === '') {
    if (optional) return undefined;
    throw badRequest('Request body must be a JSON object', 'BAD_JSON');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw badRequest('Request body is not valid JSON', 'BAD_JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw badRequest('Request body must be a JSON object', 'BAD_JSON');
  }
  return parsed as Record<string, unknown>;
}
