/** Typed errors so the HTTP layer can map them to status codes without string matching. */
export class FactoryError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly httpStatus: number = 400,
  ) {
    super(message);
    this.name = 'FactoryError';
  }
}

/** Actor is not in `allowedActors`. Must map to 403. */
export class ForbiddenError extends FactoryError {
  constructor(message: string) {
    super(message, 'FORBIDDEN', 403);
    this.name = 'ForbiddenError';
  }
}

/** Command name is not registered at all. Maps to 404. */
export class UnknownCommandError extends FactoryError {
  constructor(name: string) {
    super(`Unknown command: ${name}`, 'UNKNOWN_COMMAND', 404);
    this.name = 'UnknownCommandError';
  }
}

/** Input failed Zod validation. Maps to 400. */
export class ValidationError extends FactoryError {
  constructor(
    message: string,
    readonly issues: unknown,
  ) {
    super(message, 'VALIDATION_FAILED', 400);
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends FactoryError {
  constructor(message: string) {
    super(message, 'NOT_FOUND', 404);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends FactoryError {
  constructor(message: string) {
    super(message, 'CONFLICT', 409);
    this.name = 'ConflictError';
  }
}

export class UnauthorizedError extends FactoryError {
  constructor(message = 'Missing or invalid bearer token') {
    super(message, 'UNAUTHORIZED', 401);
    this.name = 'UnauthorizedError';
  }
}
