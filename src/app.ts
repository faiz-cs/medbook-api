// src/app.ts
// ============================================================
//  Express application setup
//  Wires middleware, routes, and error handlers
// ============================================================

import express, { Application } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import { config } from './config/env';
import { logger, stream } from './config/logger';
import { errorHandler, notFound } from './middleware';
import { authRoutes } from './modules/auth/auth.routes';
import { profileRoutes } from './modules/profile/profile.routes';
import { searchRoutes } from './modules/search/search.routes';
import { schedulingRoutes } from './modules/scheduling/scheduling.routes';
import { clinicRoutes } from './modules/clinic/clinic.routes';
import { bookingRoutes } from './modules/booking/booking.routes';
import { adminRoutes } from './modules/admin/admin.routes';
import { doctorRoutes } from './modules/doctor/doctor.routes';
import { paymentRoutes, uploadRoutes } from './modules/payment/payment.routes';

export function createApp(): Application {
  const app = express();
  app.set('trust proxy', 1);
  // ── Security headers (helmet adds X-Content-Type, HSTS, etc.) ──
  app.use(helmet());

  // ── CORS ─────────────────────────────────────────────────────
  app.use(cors({
    origin: config.app.isDev
      ? '*'                            // Allow all in dev
      : [config.app.frontendUrl],      // Strict in production
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  }));

  // ── Request parsing ───────────────────────────────────────────
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  // ── Compression ───────────────────────────────────────────────
  app.use(compression());

  // ── HTTP request logging ──────────────────────────────────────
  app.use(morgan(config.app.isDev ? 'dev' : 'combined', { stream }));

  // ── Global rate limiter ───────────────────────────────────────
  const globalLimiter = rateLimit({
    windowMs: config.rateLimit.windowMs,
    max: config.rateLimit.maxRequests,
    message: {
      success: false,
      data: null,
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many requests. Please slow down.',
      },
    },
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.use(globalLimiter);

  // ── Health check (no auth, no rate limit) ────────────────────
  app.get('/health', (_, res) => {
    res.json({
      status: 'ok',
      service: 'medbook-api',
      version: config.app.apiVersion,
      timestamp: new Date().toISOString(),
      env: config.app.nodeEnv,
    });
  });

  // ── API Routes ────────────────────────────────────────────────
  const apiBase = `/api/${config.app.apiVersion}`;

  app.use(`${apiBase}/auth`, authRoutes);
  app.use(`${apiBase}/profile`, profileRoutes);
  app.use(`${apiBase}/search`, searchRoutes);
  app.use(`${apiBase}`, schedulingRoutes);
  app.use(`${apiBase}`, clinicRoutes);
  app.use(`${apiBase}`, bookingRoutes);
  app.use(`${apiBase}`, adminRoutes);
  app.use(`${apiBase}`, doctorRoutes);
  app.use(`${apiBase}`, paymentRoutes);
  app.use(`${apiBase}`, uploadRoutes);

  // ── 404 handler ───────────────────────────────────────────────
  app.use(notFound);

  // ── Global error handler (MUST be last) ──────────────────────
  app.use(errorHandler);

  return app;
}
