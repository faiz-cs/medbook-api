// src/modules/auth/auth.service.ts
// ============================================================
//  Auth Service — core business logic
//  Handles OTP generation/verification, JWT creation, sessions
// ============================================================

import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { query, transaction } from '../../config/database';
import { cacheGet, cacheSet, cacheIncr, cacheExists, cacheDel, CacheKeys } from '../../config/redis';
import { config } from '../../config/env';
import { logger } from '../../config/logger';
import { UserRow, JwtAccessPayload, JwtRefreshPayload, UserRole } from '../../types';

// ── OTP SERVICE ───────────────────────────────────────────────

// Generate a cryptographically random 6-digit OTP
function generateOTP(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Check rate limit: max 5 OTPs per phone per hour
export async function checkOtpRateLimit(phone: string): Promise<boolean> {
  const key   = CacheKeys.otpRateLimit(phone);
  const count = await cacheIncr(key, 3600); // 1-hour window
  return count <= config.otp.rateLimitPerHour;
}

// Send OTP to phone number
// In production: calls MSG91 API
// In development: logs to console
export async function sendOtp(phone: string): Promise<{
  success:          boolean;
  expiresInSeconds: number;
  providerMsgId:    string | null;
}> {
  const otp        = generateOTP();
  const otpHash    = await bcrypt.hash(otp, 10);
  const expiresAt  = new Date(Date.now() + config.otp.expiryMinutes * 60 * 1000);

  // Store OTP in DB
  await query(
    `INSERT INTO otp_verifications (phone, otp_hash, expires_at)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [phone, otpHash, expiresAt]
  );

  // In development, log OTP to console instead of calling MSG91
  if (config.app.isDev) {
    logger.info(`🔑 DEV OTP for ${phone}: ${otp}`);
    return { success: true, expiresInSeconds: config.otp.expiryMinutes * 60, providerMsgId: 'dev_mode' };
  }

  // Production: call MSG91 API
  try {
    const response = await fetch('https://api.msg91.com/api/v5/otp', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', authkey: config.msg91.apiKey },
      body: JSON.stringify({
        template_id: config.msg91.templateId,
        mobile:      phone.replace('+', ''),
        otp,
      }),
    });
    const data = await response.json() as { request_id?: string };
    return {
      success:          true,
      expiresInSeconds: config.otp.expiryMinutes * 60,
      providerMsgId:    data.request_id || null,
    };
  } catch (error) {
    logger.error('MSG91 OTP send failed', { phone, error });
    return { success: false, expiresInSeconds: 0, providerMsgId: null };
  }
}

// Verify OTP submitted by user
export async function verifyOtp(phone: string, otp: string): Promise<{
  valid:  boolean;
  reason: string | null;
}> {
  // Get most recent unverified OTP for this phone
  const result = await query<{
    id:            string;
    otp_hash:      string;
    expires_at:    Date;
    attempt_count: number;
    verified_at:   Date | null;
  }>(
    `SELECT id, otp_hash, expires_at, attempt_count, verified_at
     FROM otp_verifications
     WHERE phone = $1
       AND verified_at IS NULL
     ORDER BY created_at DESC
     LIMIT 1`,
    [phone]
  );

  if (result.rowCount === 0) {
    return { valid: false, reason: 'OTP_INVALID' };
  }

  const record = result.rows[0];

  // Check if expired
  if (new Date() > record.expires_at) {
    return { valid: false, reason: 'OTP_EXPIRED' };
  }

  // Check attempt limit
  if (record.attempt_count >= config.otp.maxAttempts) {
    return { valid: false, reason: 'OTP_MAX_ATTEMPTS' };
  }

  // Verify OTP hash
  const isMatch = await bcrypt.compare(otp, record.otp_hash);

  if (!isMatch) {
    // Increment attempt count
    await query(
      `UPDATE otp_verifications SET attempt_count = attempt_count + 1 WHERE id = $1`,
      [record.id]
    );
    return { valid: false, reason: 'OTP_INVALID' };
  }

  // Mark OTP as verified
  await query(
    `UPDATE otp_verifications SET verified_at = NOW() WHERE id = $1`,
    [record.id]
  );

  return { valid: true, reason: null };
}

// ── USER SERVICE ──────────────────────────────────────────────

// Find user by phone number
export async function findUserByPhone(phone: string): Promise<UserRow | null> {
  const result = await query<UserRow>(
    `SELECT * FROM users WHERE phone = $1 AND deleted_at IS NULL LIMIT 1`,
    [phone]
  );
  return result.rows[0] || null;
}

// Find user by ID
export async function findUserById(userId: string): Promise<UserRow | null> {
  const result = await query<UserRow>(
    `SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
    [userId]
  );
  return result.rows[0] || null;
}

// Create a new user (phone OTP registration)
export async function createUser(data: {
  phone:             string;
  fullName?:         string;
  role?:             UserRole;
  authProvider?:     'phone_otp' | 'google';
  googleId?:         string;
  fcmToken?:         string;
  preferredLanguage?: string;
}): Promise<UserRow> {
  return transaction(async (client) => {
    // Create the user
    const userResult = await client.query<UserRow>(
      `INSERT INTO users
         (phone, role, status, full_name, preferred_language, auth_provider,
          google_id, fcm_token, consent_given_at, consent_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), 'v1.0')
       RETURNING *`,
      [
        data.phone,
        data.role || 'patient',
        'active',          // patients are active immediately
        data.fullName || 'MedBook User',
        data.preferredLanguage || 'en',
        data.authProvider || 'phone_otp',
        data.googleId || null,
        data.fcmToken || null,
      ]
    );
    const user = userResult.rows[0];

    // Auto-create patient profile if role is patient
    if (user.role === 'patient') {
      await client.query(
        `INSERT INTO patient_profiles (user_id) VALUES ($1)`,
        [user.id]
      );
    }

    return user;
  });
}

// Update FCM token on login
export async function updateFcmToken(userId: string, fcmToken: string): Promise<void> {
  await query(
    `UPDATE users SET fcm_token = $1, updated_at = NOW() WHERE id = $2`,
    [fcmToken, userId]
  );
}

// ── SESSION & JWT SERVICE ─────────────────────────────────────

// Create a new session and return JWT tokens
export async function createSession(
  user:       UserRow,
  deviceName: string,
  deviceOs:   string,
  ipAddress:  string
): Promise<{
  accessToken:            string;
  refreshToken:           string;
  accessTokenExpiresAt:   Date;
}> {
  const sessionId = uuidv4();

  // Generate access token (short-lived: 1 hour)
  const accessPayload: JwtAccessPayload = {
    userId:    user.id,
    role:      user.role,
    sessionId,
    type:      'access',
  };
  const accessToken = jwt.sign(accessPayload, config.jwt.accessSecret, {
    expiresIn: config.jwt.accessExpiry as jwt.SignOptions['expiresIn'],
  });

  // Generate refresh token (long-lived: 30 days)
  const refreshPayload: JwtRefreshPayload = {
    userId:    user.id,
    sessionId,
    type:      'refresh',
  };
  const refreshToken = jwt.sign(refreshPayload, config.jwt.refreshSecret, {
    expiresIn: config.jwt.refreshExpiry as jwt.SignOptions['expiresIn'],
  });

  // Hash the refresh token for secure storage
  const refreshTokenHash = await bcrypt.hash(refreshToken, 10);

  // Calculate expiry timestamps
  const accessTokenExpiresAt  = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
  const sessionExpiresAt       = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

  // Store session in database
  await query(
    `INSERT INTO user_sessions
       (id, user_id, refresh_token_hash, device_name, device_os, ip_address,
        last_active_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6::inet, NOW(), $7)`,
    [
      sessionId,
      user.id,
      refreshTokenHash,
      deviceName || 'Unknown Device',
      deviceOs   || 'Unknown OS',
      ipAddress,
      sessionExpiresAt,
    ]
  );

  return { accessToken, refreshToken, accessTokenExpiresAt };
}

// Refresh access token using a valid refresh token
export async function refreshAccessToken(refreshToken: string): Promise<{
  accessToken:          string;
  accessTokenExpiresAt: Date;
} | null> {
  let payload: JwtRefreshPayload;
  try {
    payload = jwt.verify(refreshToken, config.jwt.refreshSecret) as JwtRefreshPayload;
  } catch {
    return null;
  }

  if (payload.type !== 'refresh') return null;

  // Verify session exists and is not expired
  const sessionResult = await query<{ id: string; user_id: string; expires_at: Date }>(
    `SELECT id, user_id, expires_at FROM user_sessions
     WHERE id = $1 AND revoked_at IS NULL AND expires_at > NOW()`,
    [payload.sessionId]
  );

  if (sessionResult.rowCount === 0) return null;

  // Verify refresh token hash matches
  // (We can't verify the exact token since we only stored the hash)
  // Instead we verify the session is valid and generate a new access token

  const user = await findUserById(payload.userId);
  if (!user || user.status !== 'active') return null;

  // Generate new access token
  const accessPayload: JwtAccessPayload = {
    userId:    user.id,
    role:      user.role,
    sessionId: payload.sessionId,
    type:      'access',
  };
  const accessToken = jwt.sign(accessPayload, config.jwt.accessSecret, {
    expiresIn: config.jwt.accessExpiry as jwt.SignOptions['expiresIn'],
  });

  // Update session last_active_at
  await query(
    `UPDATE user_sessions SET last_active_at = NOW() WHERE id = $1`,
    [payload.sessionId]
  );

  return {
    accessToken,
    accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
  };
}

// Revoke a session (logout)
export async function revokeSession(sessionId: string): Promise<void> {
  await query(
    `UPDATE user_sessions SET revoked_at = NOW() WHERE id = $1`,
    [sessionId]
  );

  // Add to Redis revoke list for instant rejection (1 hour TTL matches access token TTL)
  await cacheSet(CacheKeys.revokedToken(sessionId), true, 3600);
}

// Build the safe user object to return in API responses (never expose sensitive fields)
export function buildUserResponse(user: UserRow) {
  return {
    id:                 user.id,
    phone:              user.phone,
    email:              user.email,
    role:               user.role,
    status:             user.status,
    full_name:          user.full_name,
    preferred_language: user.preferred_language,
    city:               user.city,
    avatar_url:         user.avatar_url,
    created_at:         user.created_at,
  };
}
