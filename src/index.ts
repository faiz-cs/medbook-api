// src/index.ts
// ============================================================
//  Server entry point
//  Connects to DB + Redis, then starts Express server
//  Graceful shutdown on SIGTERM/SIGINT
// ============================================================

import { createApp } from './app';
import { config } from './config/env';
import { logger } from './config/logger';
import { testDatabaseConnection, pool } from './config/database';
import { testRedisConnection, redisClient } from './config/redis';
import { startAllJobs } from './jobs';

async function bootstrap(): Promise<void> {
  logger.info('🚀 Starting MedBook API...', {
    environment: config.app.nodeEnv,
    port:        config.app.port,
    version:     config.app.apiVersion,
  });

  // ── Step 1: Connect to PostgreSQL ─────────────────────────
  await testDatabaseConnection();

  // ── Step 2: Connect to Redis ───────────────────────────────
  await testRedisConnection();

  // ── Step 3: Create Express app ─────────────────────────────
  const app = createApp();

  // ── Step 4: Start HTTP server ──────────────────────────────
  const server = app.listen(config.app.port, () => {
    logger.info(`✅ MedBook API running`, {
      url:         `http://localhost:${config.app.port}`,
      health:      `http://localhost:${config.app.port}/health`,
      apiBase:     `http://localhost:${config.app.port}/api/${config.app.apiVersion}`,
      environment: config.app.nodeEnv,
    });
    startAllJobs();
  });

  // ── Graceful Shutdown ──────────────────────────────────────
  // On SIGTERM (Docker stop, Kubernetes pod shutdown) or SIGINT (Ctrl+C):
  // 1. Stop accepting new requests
  // 2. Wait for in-flight requests to complete (30s timeout)
  // 3. Close DB pool and Redis connection
  // 4. Exit cleanly

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`${signal} received — shutting down gracefully...`);

    server.close(async () => {
      logger.info('HTTP server closed');

      try {
        await pool.end();
        logger.info('Database pool closed');
      } catch (err) {
        logger.error('Error closing database pool', { err });
      }

      try {
        if (redisClient) await redisClient.quit();
        logger.info('Redis connection closed');
      } catch (err) {
        logger.error('Error closing Redis', { err });
      }

      logger.info('👋 MedBook API shutdown complete');
      process.exit(0);
    });

    // Force exit after 30 seconds if graceful shutdown hangs
    setTimeout(() => {
      logger.error('Forced shutdown after 30s timeout');
      process.exit(1);
    }, 30000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));

  // ── Unhandled rejections ───────────────────────────────────
  process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Promise Rejection', { reason, promise });
  });

  process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception', { error });
    process.exit(1);
  });
}

// Start the server
bootstrap().catch((error) => {
  logger.error('❌ Failed to start MedBook API', { error });
  process.exit(1);
});
