/** Domain errors the API layer maps to HTTP status codes. */

export class NotFoundError extends Error {
  constructor(
    public readonly resource: string,
    public readonly id: string,
  ) {
    super(`${resource} ${id} not found`);
    this.name = 'NotFoundError';
  }
}

export class ValidationError extends Error {
  constructor(
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class AuthError extends Error {
  constructor(message = 'unauthorized') {
    super(message);
    this.name = 'AuthError';
  }
}

/**
 * A concurrency/ownership conflict (mapped to HTTP 409). The transport uses it when a worker acts
 * on a job it no longer owns — i.e. the job was reclaimed after its heartbeat lapsed (D-03). The
 * losing worker must stop; the reclaiming worker owns the job now.
 */
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}
