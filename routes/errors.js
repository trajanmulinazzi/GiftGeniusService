/**
 * Unified error response shape: { error: { code, message } }.
 * Keeps every route consistent and gives the client a stable contract.
 */

export const STATUS_CODE = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  429: 'RATE_LIMITED',
  500: 'INTERNAL_ERROR',
};

/** Send a structured error response and return the reply (to short-circuit). */
export function sendError(reply, status, message, code) {
  return reply.code(status).send({
    error: {
      code: code || STATUS_CODE[status] || 'ERROR',
      message,
    },
  });
}

/** Throwable error carrying an HTTP status + machine code for the handler. */
export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = status;
    this.code = code || STATUS_CODE[status] || 'ERROR';
  }
}
