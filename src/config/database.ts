// src/config/database.ts
// ============================================================
//  PostgreSQL connection pool using node-postgres (pg)
//  We use a pool (not a single client) because:
//  - A pool manages multiple connections automatically
//  - Handles connection reuse, queueing, and timeouts
//  - Much better performance under concurrent requests
// ============================================================

import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { config } from './env';
import { logger } from './logger';

// ── Create the connection pool ─────────────────────────────────
const pool = new Pool({
  host:     config.db.host,
  port:     config.db.port,
  database: config.db.name,
  user:     config.db.user,
  password: config.db.password,
  min:      config.db.poolMin,
  max:      config.db.poolMax,
  ssl:      config.db.ssl ? { rejectUnauthorized: false } : false,

  // How long a client can sit idle before being released.
  idleTimeoutMillis: 30000,

  // How long to wait for a connection before throwing an error.
  connectionTimeoutMillis: 5000,
});

// ── Connection events ─────────────────────────────────────────
pool.on('connect', () => {
  logger.debug('New database client connected to pool');
});

pool.on('error', (err) => {
  logger.error('Unexpected database pool error', { error: err.message });
  // Don't crash the process on pool errors — let the pool recover.
});

// ── Test connection on startup ────────────────────────────────
export async function testDatabaseConnection(): Promise<void> {
  let client: PoolClient | null = null;
  try {
    client = await pool.connect();
    const result = await client.query('SELECT NOW() as current_time, version()');
    logger.info('✅ Database connected', {
      time: result.rows[0].current_time,
      version: result.rows[0].version.split(' ').slice(0, 2).join(' '),
    });
  } catch (error) {
    logger.error('❌ Database connection failed', { error });
    throw error; // Crash on startup if DB is unreachable
  } finally {
    if (client) client.release();
  }
}

// ── Query helper ──────────────────────────────────────────────
// Wraps pool.query with automatic logging in development.
// Use this instead of pool.query directly in all modules.
export async function query<T extends QueryResultRow = Record<string, unknown>>(
  sql: string,
  params?: unknown[]
): Promise<QueryResult<T>> {
  const start = Date.now();
  try {
    const result = await pool.query<T>(sql, params);
    const duration = Date.now() - start;

    if (config.app.isDev) {
      logger.debug('DB query executed', {
        sql: sql.substring(0, 100), // truncate long queries in logs
        duration: `${duration}ms`,
        rows: result.rowCount,
      });
    }

    return result;
  } catch (error) {
    logger.error('DB query failed', {
      sql: sql.substring(0, 100),
      params,
      error,
    });
    throw error;
  }
}

// ── Transaction helper ────────────────────────────────────────
// Wraps a series of queries in a transaction.
// If any query throws, the entire transaction rolls back.
// Usage:
//   await transaction(async (client) => {
//     await client.query('UPDATE ...');
//     await client.query('INSERT ...');
//   });
export async function transaction<T>(
  callback: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// ── Get raw pool (for advanced use cases) ─────────────────────
export { pool };
