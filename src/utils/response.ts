// src/utils/response.ts
// ============================================================
//  Standardised API response helpers
//  Every endpoint uses these — ensures consistent response shape
// ============================================================

import { Response } from 'express';
import { ApiResponse, ApiError, PaginationMeta } from '../types';

// ── Success response ──────────────────────────────────────────
export function sendSuccess<T>(
  res: Response,
  data: T,
  statusCode: number = 200,
  meta?: PaginationMeta
): Response {
  const response: ApiResponse<T> = {
    success: true,
    data,
    error: null,
    ...(meta && { meta }),
  };
  return res.status(statusCode).json(response);
}

// ── Created response (201) ────────────────────────────────────
export function sendCreated<T>(res: Response, data: T): Response {
  return sendSuccess(res, data, 201);
}

// ── Error response ────────────────────────────────────────────
export function sendError(
  res: Response,
  statusCode: number,
  code: string,
  message: string,
  details?: Record<string, unknown>
): Response {
  const error: ApiError = { code, message, ...(details && { details }) };
  const response: ApiResponse<null> = {
    success: false,
    data:    null,
    error,
  };
  return res.status(statusCode).json(response);
}

// ── Common error shortcuts ────────────────────────────────────
export const Errors = {
  notFound:     (res: Response, message = 'Resource not found') =>
    sendError(res, 404, 'NOT_FOUND', message),

  unauthorized: (res: Response, message = 'Authentication required') =>
    sendError(res, 401, 'AUTH_TOKEN_MISSING', message),

  forbidden:    (res: Response, message = 'Access denied') =>
    sendError(res, 403, 'AUTH_FORBIDDEN', message),

  tokenExpired: (res: Response) =>
    sendError(res, 401, 'AUTH_TOKEN_EXPIRED', 'Your session has expired. Please log in again.'),

  tokenInvalid: (res: Response) =>
    sendError(res, 401, 'AUTH_TOKEN_INVALID', 'Invalid authentication token.'),

  validation:   (res: Response, details: Record<string, unknown>) =>
    sendError(res, 422, 'VALIDATION_ERROR', 'Request validation failed.', details),

  rateLimited:  (res: Response, message = 'Too many requests. Please try again later.') =>
    sendError(res, 429, 'RATE_LIMITED', message),

  conflict:     (res: Response, message: string) =>
    sendError(res, 409, 'CONFLICT', message),

  serverError:  (res: Response, message = 'An internal server error occurred.') =>
    sendError(res, 500, 'SERVER_ERROR', message),

  slotUnavailable: (res: Response) =>
    sendError(res, 409, 'SLOT_NOT_AVAILABLE', 'This slot was just booked. Please select another.'),

  slotLockExpired: (res: Response) =>
    sendError(res, 410, 'SLOT_LOCK_EXPIRED', 'Your 5-minute hold expired. Please select a new slot.'),
};

// ── Pagination helper ─────────────────────────────────────────
export function getPaginationParams(
  page: unknown,
  perPage: unknown,
  maxPerPage: number = 50
) {
  const parsedPage    = Math.max(1, parseInt(String(page) || '1', 10));
  const parsedPerPage = Math.min(
    maxPerPage,
    Math.max(1, parseInt(String(perPage) || '20', 10))
  );
  return {
    page:     parsedPage,
    per_page: parsedPerPage,
    offset:   (parsedPage - 1) * parsedPerPage,
  };
}
