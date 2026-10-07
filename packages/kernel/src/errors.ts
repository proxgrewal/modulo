export class ModuloError extends Error {
  constructor(
    message: string,
    public status = 500,
    public code = 'internal',
    public details?: unknown,
  ) {
    super(message);
  }
}
export class ValidationError extends ModuloError {
  constructor(message: string, details?: unknown) {
    super(message, 400, 'validation', details);
  }
}
export class ForbiddenError extends ModuloError {
  constructor(message = 'Forbidden') {
    super(message, 403, 'forbidden');
  }
}
export class UnauthorizedError extends ModuloError {
  constructor(message = 'Authentication required') {
    super(message, 401, 'unauthorized');
  }
}
export class NotFoundError extends ModuloError {
  constructor(message = 'Not found') {
    super(message, 404, 'not_found');
  }
}
export class ConflictError extends ModuloError {
  constructor(message: string, details?: unknown) {
    super(message, 409, 'conflict', details);
  }
}
