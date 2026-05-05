// src/config/env.ts
// ============================================================
//  Environment configuration loader
//  Validates all required env vars at startup.
//  If anything is missing, the app refuses to start.
//  This prevents silent misconfigurations in production.
// ============================================================

import dotenv from 'dotenv';
import path from 'path';

// Load .env file
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// ── Helper ────────────────────────────────────────────────────
function required(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`❌ Missing required environment variable: ${key}`);
  }
  return value;
}

function optional(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

function optionalNumber(key: string, defaultValue: number): number {
  const value = process.env[key];
  return value ? parseInt(value, 10) : defaultValue;
}

function optionalBool(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (!value) return defaultValue;
  return value.toLowerCase() === 'true';
}

// ── Config object ─────────────────────────────────────────────
export const config = {
  // App
  app: {
    nodeEnv:      optional('NODE_ENV', 'development'),
    port:         optionalNumber('PORT', 3000),
    apiVersion:   optional('API_VERSION', 'v1'),
    name:         optional('APP_NAME', 'MedBook India'),
    frontendUrl:  optional('FRONTEND_URL', 'http://localhost:3000'),
    isDev:        optional('NODE_ENV', 'development') === 'development',
    isProd:       optional('NODE_ENV', 'development') === 'production',
  },

  // Database
  db: {
    host:     optional('DB_HOST', 'localhost'),
    port:     optionalNumber('DB_PORT', 5432),
    name:     optional('DB_NAME', 'medbook_db'),
    user:     optional('DB_USER', 'medbook_user'),
    password: optional('DB_PASSWORD', ''),
    poolMin:  optionalNumber('DB_POOL_MIN', 2),
    poolMax:  optionalNumber('DB_POOL_MAX', 10),
    ssl:      optionalBool('DB_SSL', false),
  },

  // Redis
  redis: {
    host:     optional('REDIS_HOST', 'localhost'),
    port:     optionalNumber('REDIS_PORT', 6379),
    password: optional('REDIS_PASSWORD', ''),
    db:       optionalNumber('REDIS_DB', 0),
  },

  // JWT
  jwt: {
    accessSecret:   optional('JWT_ACCESS_SECRET', 'dev_access_secret_change_in_production'),
    refreshSecret:  optional('JWT_REFRESH_SECRET', 'dev_refresh_secret_change_in_production'),
    accessExpiry:   optional('JWT_ACCESS_EXPIRY', '1h'),
    refreshExpiry:  optional('JWT_REFRESH_EXPIRY', '30d'),
  },

  // OTP
  otp: {
    expiryMinutes:      optionalNumber('OTP_EXPIRY_MINUTES', 5),
    maxAttempts:        optionalNumber('OTP_MAX_ATTEMPTS', 5),
    rateLimitPerHour:   optionalNumber('OTP_RATE_LIMIT_PER_HOUR', 5),
  },

  // MSG91 SMS
  msg91: {
    apiKey:     optional('MSG91_API_KEY', ''),
    senderId:   optional('MSG91_SENDER_ID', 'MEDBK'),
    templateId: optional('MSG91_TEMPLATE_ID', ''),
  },

  // Gupshup WhatsApp
  gupshup: {
    apiKey:       optional('GUPSHUP_API_KEY', ''),
    sourceNumber: optional('GUPSHUP_SOURCE_NUMBER', ''),
    appName:      optional('GUPSHUP_APP_NAME', 'MedBook'),
  },

  // Firebase
  firebase: {
    projectId:    optional('FIREBASE_PROJECT_ID', ''),
    privateKey:   optional('FIREBASE_PRIVATE_KEY', '').replace(/\\n/g, '\n'),
    clientEmail:  optional('FIREBASE_CLIENT_EMAIL', ''),
  },

  // AWS S3
  aws: {
    region:          optional('AWS_REGION', 'ap-south-1'),
    accessKeyId:     optional('AWS_ACCESS_KEY_ID', ''),
    secretAccessKey: optional('AWS_SECRET_ACCESS_KEY', ''),
    s3Bucket:        optional('AWS_S3_BUCKET', 'medbook-uploads'),
    cloudfrontUrl:   optional('AWS_CLOUDFRONT_URL', 'https://cdn.medbook.in'),
  },

  // Razorpay
  razorpay: {
    keyId:     optional('RAZORPAY_KEY_ID', ''),
    keySecret: optional('RAZORPAY_KEY_SECRET', ''),
  },

  // Rate Limiting
  rateLimit: {
    windowMs:    optionalNumber('RATE_LIMIT_WINDOW_MS', 60000),
    maxRequests: optionalNumber('RATE_LIMIT_MAX_REQUESTS', 100),
  },

  // Business Rules
  slots: {
    generationDaysAhead: optionalNumber('SLOT_GENERATION_DAYS_AHEAD', 60),
    lockMinutes:         optionalNumber('SLOT_LOCK_MINUTES', 5),
  },

  // Logging
  logging: {
    level:   optional('LOG_LEVEL', 'debug'),
    file:    optional('LOG_FILE', 'logs/medbook.log'),
  },
} as const;

export type Config = typeof config;
