/**
 * Error types shared by the domain layer and the HTTP layer.
 *
 * The domain layer throws {@link HttpError}; the HTTP layer turns it into a
 * `{ "error": "<message>", "code": "<CODE>" }` JSON response.
 */

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

export function badRequest(message: string, code = 'VALIDATION_ERROR'): HttpError {
  return new HttpError(400, code, message);
}

export function notFound(message: string): HttpError {
  return new HttpError(404, 'NOT_FOUND', message);
}

export function conflict(code: string, message: string): HttpError {
  return new HttpError(409, code, message);
}

export function methodNotAllowed(method: string, allowed: readonly string[]): HttpError {
  return new HttpError(405, 'METHOD_NOT_ALLOWED', `Method ${method} is not allowed here (allowed: ${allowed.join(', ')})`);
}
