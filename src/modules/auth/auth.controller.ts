// src/modules/auth/auth.controller.ts
// ============================================================
//  Auth Controller — HTTP request handlers
//  Keeps handlers thin — business logic lives in auth.service.ts
// ============================================================

import { Request, Response } from 'express';
import {
  checkOtpRateLimit, sendOtp, verifyOtp,
  findUserByPhone, createUser, updateFcmToken,
  createSession, refreshAccessToken, revokeSession,
  buildUserResponse, findUserById,
} from './auth.service';
import { query } from '../../config/database';
import { sendSuccess, sendCreated, Errors } from '../../utils/response';
import { logger } from '../../config/logger';

// ── POST /v1/auth/otp/send ────────────────────────────────────
export async function sendOtpHandler(req: Request, res: Response): Promise<void> {
  const { phone } = req.body as { phone: string };

  // Check rate limit
  const withinLimit = await checkOtpRateLimit(phone);
  if (!withinLimit) {
    Errors.rateLimited(res, 'Too many OTP requests. Please try again in an hour.');
    return;
  }

  const result = await sendOtp(phone);

  if (!result.success) {
    Errors.serverError(res, 'Failed to send OTP. Please try again.');
    return;
  }

  // Mask phone for response
  const maskedPhone = phone.slice(0, 6) + '*'.repeat(phone.length - 9) + phone.slice(-3);

  sendSuccess(res, {
    otp_sent:           true,
    expires_in_seconds: result.expiresInSeconds,
    masked_phone:       maskedPhone,
  });
}

// ── POST /v1/auth/otp/verify ──────────────────────────────────
export async function verifyOtpHandler(req: Request, res: Response): Promise<void> {
  const {
    phone,
    otp,
    full_name,
    device_name,
    device_os,
    fcm_token,
    preferred_language,
  } = req.body as {
    phone:              string;
    otp:                string;
    full_name?:         string;
    device_name?:       string;
    device_os?:         string;
    fcm_token?:         string;
    preferred_language?: string;
  };

  // Verify OTP
  const verification = await verifyOtp(phone, otp);
  if (!verification.valid) {
    const errorMap: Record<string, () => void> = {
      OTP_INVALID:      () => Errors.serverError(res, 'Invalid OTP. Please check and try again.'),
      OTP_EXPIRED:      () => Errors.serverError(res, 'OTP has expired. Please request a new one.'),
      OTP_MAX_ATTEMPTS: () => Errors.rateLimited(res, 'Too many wrong attempts. Request a new OTP.'),
    };
    const handler = errorMap[verification.reason || ''];
    if (handler) { handler(); return; }
    Errors.serverError(res, 'OTP verification failed.');
    return;
  }

  // Find or create user
  let user = await findUserByPhone(phone);
  const isNewUser = !user;

  if (!user) {
    user = await createUser({
      phone,
      fullName:          full_name,
      role:              'patient',
      authProvider:      'phone_otp',
      fcmToken:          fcm_token,
      preferredLanguage: preferred_language || 'en',
    });
    logger.info('New user registered', { userId: user.id, phone: phone.slice(0, 7) + '****' });
  } else {
    // Update FCM token on re-login
    if (fcm_token) await updateFcmToken(user.id, fcm_token);
  }

  // Check account status
  if (user.status === 'suspended') {
    Errors.forbidden(res, 'Your account has been suspended. Please contact support.');
    return;
  }
  if (user.status === 'deactivated') {
    Errors.forbidden(res, 'This account has been deactivated.');
    return;
  }

  // Create session + tokens
  const { accessToken, refreshToken, accessTokenExpiresAt } = await createSession(
    user,
    device_name || 'Unknown Device',
    device_os   || 'Unknown OS',
    req.ip       || '0.0.0.0'
  );

  sendSuccess(res, {
    access_token:             accessToken,
    refresh_token:            refreshToken,
    access_token_expires_at:  accessTokenExpiresAt,
    is_new_user:              isNewUser,
    user:                     buildUserResponse(user),
  });
}

// ── POST /v1/auth/token/refresh ───────────────────────────────
export async function refreshTokenHandler(req: Request, res: Response): Promise<void> {
  const { refresh_token } = req.body as { refresh_token: string };

  const result = await refreshAccessToken(refresh_token);

  if (!result) {
    Errors.tokenExpired(res);
    return;
  }

  sendSuccess(res, {
    access_token:            result.accessToken,
    access_token_expires_at: result.accessTokenExpiresAt,
  });
}

// ── POST /v1/auth/logout ──────────────────────────────────────
export async function logoutHandler(req: Request, res: Response): Promise<void> {
  if (!req.user) { Errors.unauthorized(res); return; }

  await revokeSession(req.user.sessionId);

  sendSuccess(res, { logged_out: true });
}

// ── GET /v1/auth/me ───────────────────────────────────────────
export async function getMeHandler(req: Request, res: Response): Promise<void> {
  if (!req.user) { Errors.unauthorized(res); return; }

  const user = await findUserById(req.user.userId);
  if (!user) { Errors.notFound(res, 'User not found.'); return; }

  // Load role-specific profile
  let profile = null;
  let pendingActions: Record<string, unknown> = {};

  if (user.role === 'patient') {
    const r = await query(
      `SELECT * FROM patient_profiles WHERE user_id = $1`,
      [user.id]
    );
    profile = r.rows[0] || null;

  } else if (user.role === 'doctor') {
    const r = await query(
      `SELECT * FROM doctor_profiles WHERE user_id = $1`,
      [user.id]
    );
    profile = r.rows[0] || null;

    // Count pending schedule approvals
    if (profile) {
      const approvalCount = await query<{ count: string }>(
        `SELECT COUNT(*) as count FROM schedule_requests
         WHERE doctor_id = $1 AND status = 'pending'`,
        [profile.id]
      );
      pendingActions = {
        schedule_approvals:  parseInt(approvalCount.rows[0]?.count || '0', 10),
        verification_status: profile.verification_status,
      };
    }

  } else if (user.role === 'clinic_admin') {
    // Get clinics this user manages
    const r = await query(
      `SELECT cp.*, ca.admin_role
       FROM clinic_profiles cp
       JOIN clinic_admins ca ON ca.clinic_id = cp.id
       WHERE ca.user_id = $1 AND ca.is_active = TRUE`,
      [user.id]
    );
    profile = r.rows[0] || null;

    if (profile) {
      pendingActions = {
        verification_status: profile.verification_status,
      };
    }
  }

  sendSuccess(res, {
    user:            buildUserResponse(user),
    profile,
    pending_actions: pendingActions,
  });
}
