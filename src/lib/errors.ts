export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly context?: Record<string, unknown>;

  constructor(
    message: string,
    statusCode: number,
    code: string,
    context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.context = context;
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.context && { context: this.context }),
      },
    };
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id?: string) {
    super(
      id ? `${resource} with id '${id}' not found` : `${resource} not found`,
      404,
      'NOT_FOUND',
      { resource, id },
    );
  }
}

export class ValidationError extends AppError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 422, 'VALIDATION_ERROR', context);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 409, 'CONFLICT', context);
  }
}

export class SafetyViolationError extends AppError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 403, 'SAFETY_VIOLATION', context);
  }
}

export class TimeoutError extends AppError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 408, 'TIMEOUT', context);
  }
}

/** Type guard for AppError instances */
export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
