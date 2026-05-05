// src/modules/payment/payment.routes.ts
import { Router, Request, Response, RequestHandler } from 'express';
import { z } from 'zod';
import { authenticate, requireRole, validate } from '../../middleware';
import { sendSuccess, Errors } from '../../utils/response';
import {
  createPaymentOrder, verifyAndCapturePayment,
  processRefund, verifyWebhookSignature,
} from './payment.service';
import { logger } from '../../config/logger';

const router = Router();

// POST /v1/payments/create-order
router.post('/payments/create-order',
  authenticate as RequestHandler,
  requireRole('patient') as RequestHandler,
  validate(z.object({ booking_id: z.string().uuid() })) as RequestHandler,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const order = await createPaymentOrder(
        req.body.booking_id,
        0, // amount pulled from booking record
        req.user!.userId
      );
      sendSuccess(res, { order }, 201);
    } catch (err) {
      if (err instanceof Error) {
        if (err.message === 'BOOKING_NOT_FOUND') {
          Errors.notFound(res, 'Booking not found or already confirmed.'); return;
        }
      }
      throw err;
    }
  }
);

// POST /v1/payments/verify
router.post('/payments/verify',
  authenticate as RequestHandler,
  requireRole('patient') as RequestHandler,
  validate(z.object({
    booking_id:         z.string().uuid(),
    order_id:           z.string(),
    payment_id:         z.string(),
    razorpay_signature: z.string(),
  })) as RequestHandler,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const result = await verifyAndCapturePayment(
        req.body.order_id,
        req.body.payment_id,
        req.body.razorpay_signature,
        req.body.booking_id
      );
      sendSuccess(res, result);
    } catch (err) {
      if (err instanceof Error) {
        if (err.message === 'INVALID_SIGNATURE') {
          Errors.serverError(res, 'Payment verification failed. Contact support.'); return;
        }
        if (err.message === 'PAYMENT_NOT_CAPTURED') {
          Errors.conflict(res, 'Payment not yet captured. Please retry.'); return;
        }
      }
      throw err;
    }
  }
);

// POST /v1/payments/refund
router.post('/payments/refund',
  authenticate as RequestHandler,
  requireRole('platform_admin') as RequestHandler,
  validate(z.object({
    booking_id: z.string().uuid(),
    reason:     z.string().max(300),
  })) as RequestHandler,
  async (req: Request, res: Response): Promise<void> => {
    const { refundId, amountPaise } = await processRefund(req.body.booking_id, req.body.reason);
    sendSuccess(res, { refund_id: refundId, amount_paise: amountPaise, status: 'refunded' });
  }
);

// POST /v1/payments/webhook  — Razorpay webhook (no auth — signature-verified)
router.post('/payments/webhook',
  async (req: Request, res: Response): Promise<void> => {
    const signature = req.headers['x-razorpay-signature'] as string;
    if (!signature) { res.status(400).json({ error: 'Missing signature' }); return; }

    const rawBody = JSON.stringify(req.body);
    const valid = verifyWebhookSignature(rawBody, signature);

    if (!valid) {
      logger.warn('Invalid Razorpay webhook signature');
      res.status(400).json({ error: 'Invalid signature' });
      return;
    }

    const event   = req.body.event as string;
    const payload = req.body.payload as Record<string, unknown>;

    logger.info('Razorpay webhook received', { event });

    // Handle payment events
    switch (event) {
      case 'payment.captured':
        logger.info('Payment captured via webhook', {
          paymentId: (payload.payment as Record<string, unknown>)?.entity,
        });
        break;
      case 'payment.failed':
        logger.warn('Payment failed via webhook', {
          paymentId: (payload.payment as Record<string, unknown>)?.entity,
        });
        break;
      case 'refund.created':
        logger.info('Refund created via webhook');
        break;
    }

    res.json({ status: 'ok' });
  }
);

export { router as paymentRoutes };


// ============================================================
//  S3 Upload Routes
//  Generates pre-signed URLs for secure direct-to-S3 uploads
//  Files never pass through our server — upload goes direct
// ============================================================

// src/modules/upload/upload.routes.ts (combined in this file)
import { Router as UploadRouter } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../../config/env';

const uploadRouter = UploadRouter();

// Document types allowed
type DocType = 'nmc_certificate' | 'clinic_license' | 'avatar' | 'clinic_photo';

const ALLOWED_TYPES: Record<DocType, { maxSizeMB: number; mimeTypes: string[] }> = {
  nmc_certificate: { maxSizeMB: 5,  mimeTypes: ['application/pdf','image/jpeg','image/png'] },
  clinic_license:  { maxSizeMB: 5,  mimeTypes: ['application/pdf','image/jpeg','image/png'] },
  avatar:          { maxSizeMB: 2,  mimeTypes: ['image/jpeg','image/png','image/webp'] },
  clinic_photo:    { maxSizeMB: 10, mimeTypes: ['image/jpeg','image/png','image/webp'] },
};

// POST /v1/uploads/presign — get a pre-signed URL for S3 upload
uploadRouter.post('/uploads/presign',
  authenticate as RequestHandler,
  validate(z.object({
    doc_type:  z.enum(['nmc_certificate','clinic_license','avatar','clinic_photo']),
    file_name: z.string().max(255),
    mime_type: z.string(),
  })) as RequestHandler,
  async (req: Request, res: Response): Promise<void> => {
    const { doc_type, file_name, mime_type } = req.body as {
      doc_type: DocType; file_name: string; mime_type: string;
    };

    const allowed = ALLOWED_TYPES[doc_type];
    if (!allowed.mimeTypes.includes(mime_type)) {
      Errors.validation(res, { mime_type: [`Allowed types: ${allowed.mimeTypes.join(', ')}`] });
      return;
    }

    // Build S3 key
    const ext    = file_name.split('.').pop() || 'bin';
    const fileId = uuidv4();
    const s3Key  = `${doc_type}/${req.user!.userId}/${fileId}.${ext}`;
    const cdnUrl = `${config.aws.cloudfrontUrl}/${s3Key}`;

    // In production: use AWS SDK to generate pre-signed URL
    // Here we return the structure — AWS SDK call would be:
    // const presignedUrl = await s3.getSignedUrlPromise('putObject', {
    //   Bucket:      config.aws.s3Bucket,
    //   Key:         s3Key,
    //   ContentType: mime_type,
    //   Expires:     300, // 5 minutes
    // });

    // Development: return mock pre-signed URL
    const presignedUrl = config.app.isDev
      ? `https://mock-s3.example.com/upload?key=${s3Key}&token=dev`
      : `https://${config.aws.s3Bucket}.s3.${config.aws.region}.amazonaws.com/${s3Key}?X-Amz-Signature=...`;

    sendSuccess(res, {
      upload_url:   presignedUrl,
      cdn_url:      cdnUrl,
      s3_key:       s3Key,
      expires_in:   300,
      max_size_mb:  allowed.maxSizeMB,
    });
  }
);

export { uploadRouter as uploadRoutes };
