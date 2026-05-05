// src/modules/payment/payment.service.ts
// ============================================================
//  Razorpay Payment Service
//  Handles UPI order creation, webhook verification,
//  payment confirmation and refunds
// ============================================================

import crypto from 'crypto';
import { query, transaction } from '../../config/database';
import { config } from '../../config/env';
import { logger } from '../../config/logger';

// ── Razorpay API helper ───────────────────────────────────────
async function razorpayRequest(
  method: string,
  path:   string,
  body?:  Record<string, unknown>
): Promise<Record<string, unknown>> {
  const credentials = Buffer.from(
    `${config.razorpay.keyId}:${config.razorpay.keySecret}`
  ).toString('base64');

  const response = await fetch(`https://api.razorpay.com/v1${path}`, {
    method,
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type':  'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await response.json() as Record<string, unknown>;

  if (!response.ok) {
    logger.error('Razorpay API error', { path, status: response.status, data });
    throw new Error(`Razorpay error: ${JSON.stringify(data)}`);
  }

  return data;
}

// ── Create payment order ──────────────────────────────────────
// Called when patient selects online payment during booking
export async function createPaymentOrder(
  bookingId:      string,
  amountPaise:    number,
  patientUserId:  string
): Promise<{
  orderId:       string;
  amount:        number;
  currency:      string;
  keyId:         string;
}> {
  // Verify booking belongs to patient and is in initiated state
  const bookingResult = await query<{
    id: string; booking_reference: string; status: string; fee_paise: number;
  }>(
    `SELECT b.id, b.booking_reference, b.status, b.fee_paise
     FROM bookings b
     JOIN patient_profiles pp ON pp.id = b.patient_id
     WHERE b.id = $1 AND pp.user_id = $2 AND b.status = 'initiated'`,
    [bookingId, patientUserId]
  );

  if (bookingResult.rowCount === 0) {
    throw new Error('BOOKING_NOT_FOUND');
  }

  const booking = bookingResult.rows[0];

  // Create Razorpay order
  const order = await razorpayRequest('POST', '/orders', {
    amount:          booking.fee_paise, // already in paise
    currency:        'INR',
    receipt:         booking.booking_reference,
    payment_capture: 1,
    notes: {
      booking_id: bookingId,
      platform:   'medbook_india',
    },
  });

  // Store order in payments table
  await query(
    `INSERT INTO payments
       (booking_id, razorpay_order_id, amount_paise, currency, status)
     VALUES ($1, $2, $3, 'INR', 'pending')`,
    [bookingId, order['id'], booking.fee_paise]
  );

  logger.info('Payment order created', {
    bookingId,
    orderId: order['id'],
    amountPaise: booking.fee_paise,
  });

  return {
    orderId:  order['id'] as string,
    amount:   booking.fee_paise,
    currency: 'INR',
    keyId:    config.razorpay.keyId,
  };
}

// ── Verify payment signature ──────────────────────────────────
// Called after Razorpay callback in the Flutter app
export async function verifyAndCapturePayment(
  orderId:           string,
  paymentId:         string,
  razorpaySignature: string,
  bookingId:         string
): Promise<{ success: boolean; paymentStatus: string }> {

  // Verify HMAC signature
  const expectedSignature = crypto
    .createHmac('sha256', config.razorpay.keySecret)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');

  if (expectedSignature !== razorpaySignature) {
    logger.warn('Invalid Razorpay signature', { bookingId, orderId });
    throw new Error('INVALID_SIGNATURE');
  }

  // Fetch payment from Razorpay to confirm
  const payment = await razorpayRequest('GET', `/payments/${paymentId}`);
  const status  = payment['status'] as string;

  if (status !== 'captured' && status !== 'authorized') {
    throw new Error('PAYMENT_NOT_CAPTURED');
  }

  // Update payment record
  await transaction(async (client) => {
    await client.query(
      `UPDATE payments
       SET razorpay_payment_id = $1, razorpay_signature = $2,
           status = 'paid', paid_at = NOW(), updated_at = NOW()
       WHERE razorpay_order_id = $3`,
      [paymentId, razorpaySignature, orderId]
    );

    // Update booking payment status
    await client.query(
      `UPDATE bookings
       SET payment_status = 'paid', payment_gateway_ref = $1,
           payment_confirmed_at = NOW(), updated_at = NOW()
       WHERE id = $2`,
      [paymentId, bookingId]
    );
  });

  logger.info('Payment captured', { bookingId, paymentId, orderId });

  return { success: true, paymentStatus: 'paid' };
}

// ── Process refund ────────────────────────────────────────────
export async function processRefund(
  bookingId: string,
  reason:    string
): Promise<{ refundId: string; amountPaise: number }> {

  // Get payment info
  const paymentResult = await query<{
    razorpay_payment_id: string; amount_paise: number;
  }>(
    `SELECT p.razorpay_payment_id, p.amount_paise
     FROM payments p WHERE p.booking_id = $1 AND p.status = 'paid'`,
    [bookingId]
  );

  if (paymentResult.rowCount === 0) {
    throw new Error('PAYMENT_NOT_FOUND');
  }

  const payment = paymentResult.rows[0];

  // Create refund via Razorpay
  const refund = await razorpayRequest(
    'POST',
    `/payments/${payment.razorpay_payment_id}/refund`,
    {
      amount: payment.amount_paise,
      notes:  { reason, booking_id: bookingId },
    }
  );

  // Update payment record
  await query(
    `UPDATE payments
     SET status = 'refunded', razorpay_refund_id = $1,
         refunded_at = NOW(), updated_at = NOW()
     WHERE booking_id = $2`,
    [refund['id'], bookingId]
  );

  // Update booking
  await query(
    `UPDATE bookings SET payment_status = 'refunded', updated_at = NOW()
     WHERE id = $1`,
    [bookingId]
  );

  logger.info('Refund processed', {
    bookingId,
    refundId:    refund['id'],
    amountPaise: payment.amount_paise,
  });

  return {
    refundId:    refund['id'] as string,
    amountPaise: payment.amount_paise,
  };
}

// ── Razorpay webhook handler ──────────────────────────────────
export function verifyWebhookSignature(
  body:      string,
  signature: string
): boolean {
  const webhookSecret = config.razorpay.keySecret;
  const expected = crypto
    .createHmac('sha256', webhookSecret)
    .update(body)
    .digest('hex');
  return expected === signature;
}
