// src/modules/auth/auth.routes.ts
// ============================================================
//  Auth Routes — wires endpoints to controllers + validation
// ============================================================

import { Router } from 'express';
import { z } from 'zod';
import {
  sendOtpHandler,
  verifyOtpHandler,
  refreshTokenHandler,
  logoutHandler,
  getMeHandler,
} from './auth.controller';
import { authenticate, validate } from '../../middleware';

const router = Router();

// ── Validation Schemas ────────────────────────────────────────

const SendOtpSchema = z.object({
  phone: z
    .string()
    .regex(/^\+91[6-9]\d{9}$/, 'Phone must be a valid Indian number: +91XXXXXXXXXX'),
});

const VerifyOtpSchema = z.object({
  phone: z
    .string()
    .regex(/^\+91[6-9]\d{9}$/, 'Phone must be a valid Indian number'),
  otp: z
    .string()
    .length(6, 'OTP must be exactly 6 digits')
    .regex(/^\d{6}$/, 'OTP must contain only digits'),
  full_name: z
    .string()
    .min(2, 'Name must be at least 2 characters')
    .max(100, 'Name too long')
    .optional(),
  device_name: z.string().max(100).optional(),
  device_os:   z.string().max(50).optional(),
  fcm_token:   z.string().optional(),
  preferred_language: z
    .enum(['en', 'hi', 'kn', 'ta', 'te', 'mr'])
    .default('en')
    .optional(),
});

const RefreshTokenSchema = z.object({
  refresh_token: z.string().min(1, 'Refresh token is required'),
});

// ── Routes ────────────────────────────────────────────────────

// PUBLIC — No auth required
router.post('/otp/send',       validate(SendOtpSchema),       sendOtpHandler);
router.post('/otp/verify',     validate(VerifyOtpSchema),     verifyOtpHandler);
router.post('/token/refresh',  validate(RefreshTokenSchema),  refreshTokenHandler);

// PROTECTED — Auth required
router.post('/logout',  authenticate, logoutHandler);
router.get('/me',       authenticate, getMeHandler);

export { router as authRoutes };
