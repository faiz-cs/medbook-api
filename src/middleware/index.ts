// src/middleware/index.ts
// ============================================================
//  Core middleware stack
//  1. authenticate     — verifies JWT, populates req.user
//  2. requireRole      — role-based access control
//  3. validate         — Zod schema validation
//  4. errorHandler     — global error handler (always last)
//  5. notFound         — catch-all 404 handler
// ============================================================

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { ZodSchema } from 'zod';
import { config } from '../config/env';
import { logger } from '../config/logger';
import { cacheExists, CacheKeys } from '../config/redis';
import { Errors } from '../utils/response';
import { JwtAccessPayload, UserRole } from '../types';

// ── 1. AUTHENTICATE ───────────────────────────────────────────
// Extracts and verifies JWT from Authorization header.
// Populates req.user with userId, role, and sessionId.
// Returns 401 if token is missing, invalid, or revoked.

export async function authenticate(
  req:  Request,
  res:  Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      Errors.unauthorized(res);
      return;
    }

    const token = authHeader.split(' ')[1];

    // Verify the JWT signature and expiry
    let payload: JwtAccessPayload;
    try {
      payload = jwt.verify(token, config.jwt.accessSecret) as JwtAccessPayload;
    } catch (err) {
      if (err instanceof jwt.TokenExpiredError) {
        Errors.tokenExpired(res);
        return;
      }
      Errors.tokenInvalid(res);
      return;
    }

    // Ensure it's an access token (not a refresh token used as access)
    if (payload.type !== 'access') {
      Errors.tokenInvalid(res);
      return;
    }

    // Check if this session has been revoked (user logged out)
    const isRevoked = await cacheExists(
      CacheKeys.revokedToken(payload.sessionId)
    );
    if (isRevoked) {
      Errors.tokenExpired(res);
      return;
    }

    // Attach user info to request
    req.user = {
      userId:    payload.userId,
      role:      payload.role,
      sessionId: payload.sessionId,
    };

    next();
  } catch (error) {
    logger.error('Authentication middleware error', { error });
    Errors.serverError(res);
  }
}

// ── 2. REQUIRE ROLE ───────────────────────────────────────────
// Role-based access control middleware factory.
// Usage: router.get('/route', authenticate, requireRole('doctor'), handler)
// Multiple roles: requireRole('doctor', 'platform_admin')

export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      Errors.unauthorized(res);
      return;
    }

    if (!roles.includes(req.user.role)) {
      Errors.forbidden(
        res,
        `This endpoint requires one of these roles: ${roles.join(', ')}`
      );
      return;
    }

    next();
  };
}

// ── 3. VALIDATE ───────────────────────────────────────────────
// Zod schema validation middleware factory.
// Validates req.body (or req.query for GET requests).
// Returns 422 with field-level errors if validation fails.
// Usage: router.post('/route', validate(MySchema), handler)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function validate(schema: ZodSchema<any>, target: 'body' | 'query' | 'params' = 'body') {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req[target]);

    if (!result.success) {
      const details: Record<string, string[]> = {};
      result.error.issues.forEach((issue) => {
        const field = issue.path.join('.');
        if (!details[field]) details[field] = [];
        details[field].push(issue.message);
      });

      Errors.validation(res, details);
      return;
    }

    // Replace req[target] with the parsed (sanitised) data
    req[target] = result.data;
    next();
  };
}

// ── 4. ERROR HANDLER ──────────────────────────────────────────
// Global error handler — must be registered LAST in Express.
// Catches any error thrown by route handlers.
// Prevents stack traces from leaking to clients in production.

export function errorHandler(
  err:  Error,
  req:  Request,
  res:  Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  next: NextFunction
): void {
  logger.error('Unhandled error', {
    message: err.message,
    stack:   err.stack,
    path:    req.path,
    method:  req.method,
    userId:  req.user?.userId,
  });

  // Don't expose error details in production
  const message = config.app.isDev
    ? err.message
    : 'An internal server error occurred.';

  Errors.serverError(res, message);
}

// ── 5. NOT FOUND ──────────────────────────────────────────────
// Catch-all for routes that don't exist.
// Register after all routes.

export function notFound(req: Request, res: Response): void {
  Errors.notFound(res, `Route ${req.method} ${req.path} not found`);
}
