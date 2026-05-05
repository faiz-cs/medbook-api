// src/config/redis.ts
// ============================================================
//  Redis client — with graceful fallback when Redis unavailable
//  On Render free tier: Redis is not available
//  The app runs fine without it — caching is just disabled
// ============================================================

import Redis from 'ioredis';
import { config } from './env';
import { logger } from './logger';

// ── Track connection state ─────────────────────────────────────
let redisAvailable = false;
let redisClient: Redis | null = null;

// ── Create Redis client (only if host is configured) ──────────
function createClient(): Redis | null {
  if (!config.redis.host || config.redis.host === 'localhost' && config.app.isProd) {
    logger.warn('Redis not configured — running without cache (degraded mode)');
    return null;
  }

  const client = new Redis({
    host:                 config.redis.host,
    port:                 config.redis.port,
    password:             config.redis.password || undefined,
    db:                   config.redis.db,
    lazyConnect:          true,
    enableReadyCheck:     false,
    maxRetriesPerRequest: 1,
    retryStrategy: (times) => {
      if (times > 3) {
        logger.warn('Redis unavailable — running without cache');
        return null; // stop retrying
      }
      return Math.min(times * 1000, 5000);
    },
  });

  client.on('connect', () => {
    redisAvailable = true;
    logger.info('✅ Redis connected');
  });

  client.on('error', (err) => {
    if (redisAvailable) {
      logger.warn('Redis connection lost — cache disabled', { error: err.message });
      redisAvailable = false;
    }
  });

  return client;
}

redisClient = createClient();

// ── Test connection (non-fatal) ───────────────────────────────
export async function testRedisConnection(): Promise<void> {
  if (!redisClient) {
    logger.warn('⚠️  Redis skipped — cache disabled (Render free tier)');
    return;
  }
  try {
    await redisClient.connect();
    await redisClient.ping();
    redisAvailable = true;
    logger.info('✅ Redis ping successful');
  } catch (error) {
    redisAvailable = false;
    logger.warn('⚠️  Redis unavailable — app will run without cache', { error });
    // Don't throw — app continues without Redis
  }
}

// ── Safe cache operations (no-op when Redis unavailable) ──────

export async function cacheSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  if (!redisClient || !redisAvailable) return;
  try {
    await redisClient.setex(key, ttlSeconds, JSON.stringify(value));
  } catch { /* ignore */ }
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  if (!redisClient || !redisAvailable) return null;
  try {
    const value = await redisClient.get(key);
    if (!value) return null;
    return JSON.parse(value) as T;
  } catch { return null; }
}

export async function cacheDel(key: string): Promise<void> {
  if (!redisClient || !redisAvailable) return;
  try { await redisClient.del(key); } catch { /* ignore */ }
}

export async function cacheDelPattern(pattern: string): Promise<void> {
  if (!redisClient || !redisAvailable) return;
  try {
    const keys = await redisClient.keys(pattern);
    if (keys.length > 0) await redisClient.del(...keys);
  } catch { /* ignore */ }
}

export async function cacheIncr(key: string, ttlSeconds?: number): Promise<number> {
  if (!redisClient || !redisAvailable) return 0;
  try {
    const value = await redisClient.incr(key);
    if (ttlSeconds && value === 1) await redisClient.expire(key, ttlSeconds);
    return value;
  } catch { return 0; }
}

export async function cacheExists(key: string): Promise<boolean> {
  if (!redisClient || !redisAvailable) return false;
  try {
    const result = await redisClient.exists(key);
    return result === 1;
  } catch { return false; }
}

// ── Cache key builders ─────────────────────────────────────────
export const CacheKeys = {
  otpRateLimit:    (phone: string) => `otp:rate:${phone}`,
  otpAttempts:     (phone: string) => `otp:attempts:${phone}`,
  revokedToken:    (tokenHash: string) => `token:revoked:${tokenHash}`,
  doctorSlots:     (doctorId: string, clinicId: string, date: string) => `slots:${doctorId}:${clinicId}:${date}`,
  searchResults:   (queryHash: string) => `search:${queryHash}`,
  doctorProfile:   (doctorId: string) => `doctor:profile:${doctorId}`,
  clinicDashboard: (clinicId: string) => `clinic:dashboard:${clinicId}`,
  slotLock:        (slotId: string) => `slot:lock:${slotId}`,
} as const;

export { redisClient };
