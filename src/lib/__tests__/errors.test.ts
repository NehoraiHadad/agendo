import { describe, it, expect } from 'vitest';
import {
  AppError,
  NotFoundError,
  ValidationError,
  ConflictError,
  SafetyViolationError,
  TimeoutError,
  isAppError,
} from '../errors';

describe('AppError', () => {
  it('creates with correct properties', () => {
    const err = new AppError('test', 500, 'TEST');
    expect(err.message).toBe('test');
    expect(err.statusCode).toBe(500);
    expect(err.code).toBe('TEST');
    expect(err.name).toBe('AppError');
  });

  it('serializes to JSON without internal details', () => {
    const err = new AppError('oops', 500, 'INTERNAL');
    const json = err.toJSON();
    expect(json).toEqual({
      error: { code: 'INTERNAL', message: 'oops' },
    });
  });

  it('includes context in JSON when provided', () => {
    const err = new AppError('bad', 400, 'BAD', { field: 'name' });
    const json = err.toJSON();
    expect(json.error.context).toEqual({ field: 'name' });
  });
});

describe('NotFoundError', () => {
  it('creates with resource and id', () => {
    const err = new NotFoundError('Task', 'abc-123');
    expect(err.statusCode).toBe(404);
    expect(err.code).toBe('NOT_FOUND');
    expect(err.message).toContain('Task');
    expect(err.message).toContain('abc-123');
  });

  it('creates with resource only', () => {
    const err = new NotFoundError('Agent');
    expect(err.message).toBe('Agent not found');
  });
});

describe('ValidationError', () => {
  it('has 422 status code', () => {
    const err = new ValidationError('Invalid input');
    expect(err.statusCode).toBe(422);
    expect(err.code).toBe('VALIDATION_ERROR');
  });
});

describe('ConflictError', () => {
  it('has 409 status code', () => {
    const err = new ConflictError('Invalid transition');
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe('CONFLICT');
  });
});

describe('SafetyViolationError', () => {
  it('has 403 status code', () => {
    const err = new SafetyViolationError('Working dir not in allowlist');
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe('SAFETY_VIOLATION');
  });
});

describe('TimeoutError', () => {
  it('has 408 status code', () => {
    const err = new TimeoutError('Execution timed out');
    expect(err.statusCode).toBe(408);
    expect(err.code).toBe('TIMEOUT');
  });
});

describe('isAppError', () => {
  it('returns true for AppError instances', () => {
    expect(isAppError(new AppError('x', 500, 'X'))).toBe(true);
    expect(isAppError(new NotFoundError('x'))).toBe(true);
    expect(isAppError(new ValidationError('x'))).toBe(true);
  });

  it('returns false for plain Error', () => {
    expect(isAppError(new Error('x'))).toBe(false);
  });

  it('returns false for non-error values', () => {
    expect(isAppError(null)).toBe(false);
    expect(isAppError(undefined)).toBe(false);
    expect(isAppError('error')).toBe(false);
    expect(isAppError({ message: 'x' })).toBe(false);
  });
});
