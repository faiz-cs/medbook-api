// src/config/logger.ts
// ============================================================
//  Winston logger — structured JSON logging
//  In development: pretty colored console output
//  In production: JSON format for CloudWatch ingestion
// ============================================================

import winston from 'winston';
import path from 'path';
import fs from 'fs';

// Ensure logs directory exists
const logsDir = path.resolve(__dirname, '../../logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const isDev = process.env.NODE_ENV !== 'production';

// ── Custom format for development ─────────────────────────────
const devFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.printf(({ level, message, timestamp, ...meta }) => {
    const metaStr = Object.keys(meta).length
      ? '\n' + JSON.stringify(meta, null, 2)
      : '';
    return `${timestamp} [${level}]: ${message}${metaStr}`;
  })
);

// ── JSON format for production ─────────────────────────────────
const prodFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

// ── Create logger ──────────────────────────────────────────────
export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'debug',
  format: isDev ? devFormat : prodFormat,
  defaultMeta: {
    service: 'medbook-api',
    environment: process.env.NODE_ENV || 'development',
  },
  transports: [
    // Always log to console
    new winston.transports.Console(),

    // Log errors to separate file
    new winston.transports.File({
      filename: path.join(logsDir, 'error.log'),
      level: 'error',
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 5,
    }),

    // Log everything to combined file
    new winston.transports.File({
      filename: path.join(logsDir, 'medbook.log'),
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 10,
    }),
  ],
});

// ── Request logger helper ──────────────────────────────────────
// Used by morgan middleware to pipe HTTP logs through winston
export const stream = {
  write: (message: string) => {
    logger.http(message.trim());
  },
};
