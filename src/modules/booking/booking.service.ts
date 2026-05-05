// src/modules/booking/booking.service.ts
// ============================================================
//  Booking Service
//  Full lifecycle: initiate → confirm → complete / cancel / reschedule
//  All mutations go through atomic DB functions (Phase 4 schema)
// ============================================================

import { query, transaction } from '../../config/database';
import { cacheSet, CacheKeys, cacheDel, cacheDelPattern } from '../../config/redis';
import { config } from '../../config/env';
import { logger } from '../../config/logger';
import { BookingRow, BookingStatus, PaymentMethod } from '../../types';

// ── Booking reference generator ───────────────────────────────
// Format: MB-XXXXX (e.g. MB-30841)
async function generateBookingReference(): Promise<string> {
  let ref: string;
  let attempts = 0;
  do {
    const num = Math.floor(10000 + Math.random() * 89999);
    ref = `MB-${num}`;
    const exists = await query(
      `SELECT id FROM bookings WHERE booking_reference = $1`,
      [ref]
    );
    if (exists.rowCount === 0) break;
    attempts++;
  } while (attempts < 10);
  return ref;
}

// ── INITIATE BOOKING ─────────────────────────────────────────
// Step 1: Lock the slot and create booking in 'initiated' status
// The slot is held for SLOT_LOCK_MINUTES (5 min default)

export async function initiateBooking(input: {
  patientUserId:  string;
  slotId:         string;
  sessionId:      string;
  reasonForVisit?: string;
  paymentMethod:  PaymentMethod;
}): Promise<{
  bookingId:       string;
  bookingReference: string;
  slotLockedUntil: Date;
  doctor:          Record<string, unknown>;
  clinic:          Record<string, unknown>;
  appointment:     Record<string, unknown>;
  feePaise:        number;
}> {
  return transaction(async (client) => {

    // Get the patient profile id
    const patientResult = await client.query<{ id: string }>(
      `SELECT id FROM patient_profiles WHERE user_id = $1`,
      [input.patientUserId]
    );
    if (patientResult.rowCount === 0) throw new Error('PATIENT_NOT_FOUND');
    const patientId = patientResult.rows[0].id;

    // Lock the slot row — SELECT FOR UPDATE prevents concurrent booking
    const slotResult = await client.query<{
      id: string; doctor_id: string; clinic_id: string;
      slot_date: Date; slot_start_at: Date; slot_end_at: Date;
      status: string; is_locked: boolean; duration_minutes: number;
    }>(
      `SELECT id, doctor_id, clinic_id, slot_date, slot_start_at, slot_end_at,
              status, is_locked, duration_minutes
       FROM time_slots
       WHERE id = $1
       FOR UPDATE`,
      [input.slotId]
    );

    if (slotResult.rowCount === 0) throw new Error('SLOT_NOT_FOUND');

    const slot = slotResult.rows[0];

    // Verify slot is truly available
    if (slot.status !== 'available' || slot.is_locked) {
      throw new Error('SLOT_NOT_AVAILABLE');
    }

    // Get doctor fee
    const doctorResult = await client.query<{
      id: string; consultation_fee_paise: number;
      full_name: string; primary_specialty: string; avatar_url: string | null;
    }>(
      `SELECT dp.id, dp.consultation_fee_paise, u.full_name, dp.primary_specialty, u.avatar_url
       FROM doctor_profiles dp JOIN users u ON u.id = dp.user_id
       WHERE dp.id = $1`,
      [slot.doctor_id]
    );

    const doctor = doctorResult.rows[0];

    // Get clinic info
    const clinicResult = await client.query<{
      id: string; name: string; address_line1: string; neighbourhood: string; city: string;
    }>(
      `SELECT id, name, address_line1, neighbourhood, city FROM clinic_profiles WHERE id = $1`,
      [slot.clinic_id]
    );
    const clinic = clinicResult.rows[0];

    // Generate booking reference
    const bookingReference = await generateBookingReference();

    // Create booking in 'initiated' status
    const bookingResult = await client.query<{ id: string }>(
      `INSERT INTO bookings (
         booking_reference, patient_id, doctor_id, clinic_id, slot_id,
         appointment_date, appointment_start_at, appointment_end_at,
         status, reason_for_visit, payment_method, payment_status, fee_paise
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'initiated',$9,$10,'not_applicable',$11)
       RETURNING id`,
      [
        bookingReference,
        patientId,
        slot.doctor_id,
        slot.clinic_id,
        slot.id,
        slot.slot_date,
        slot.slot_start_at,
        slot.slot_end_at,
        input.reasonForVisit || null,
        input.paymentMethod,
        doctor.consultation_fee_paise,
      ]
    );

    const bookingId = bookingResult.rows[0].id;

    // Lock the slot with a 5-minute TTL
    const lockUntil = new Date(Date.now() + config.slots.lockMinutes * 60 * 1000);

    await client.query(
      `UPDATE time_slots
       SET is_locked = TRUE, locked_at = NOW(),
           locked_by_session = $2, updated_at = NOW()
       WHERE id = $1`,
      [slot.id, input.sessionId]
    );

    // Also set Redis lock as backup expiry mechanism (graceful if Redis unavailable)
    await cacheSet(
      CacheKeys.slotLock(slot.id),
      { bookingId, sessionId: input.sessionId },
      config.slots.lockMinutes * 60
    );

    logger.info('Booking initiated', { bookingId, slotId: slot.id, patientId });

    return {
      bookingId,
      bookingReference,
      slotLockedUntil: lockUntil,
      doctor: {
        name:      doctor.full_name,
        specialty: doctor.primary_specialty,
        avatar_url: doctor.avatar_url,
      },
      clinic: {
        name:    clinic.name,
        address: `${clinic.address_line1}, ${clinic.neighbourhood}, ${clinic.city}`,
      },
      appointment: {
        date:     slot.slot_date,
        start_at: slot.slot_start_at,
        end_at:   slot.slot_end_at,
      },
      feePaise: doctor.consultation_fee_paise,
    };
  });
}

// ── CONFIRM BOOKING ───────────────────────────────────────────
// Step 2: Confirm the initiated booking (calls atomic DB function)

export async function confirmBooking(
  bookingId: string,
  sessionId: string
): Promise<{ bookingReference: string }> {

  // Call the atomic DB function from Phase 4 schema
  await query(
    `SELECT confirm_booking($1, $2)`,
    [bookingId, sessionId]
  );

  // Get the booking reference
  const result = await query<{ booking_reference: string }>(
    `SELECT booking_reference FROM bookings WHERE id = $1`,
    [bookingId]
  );

  // Clear slot cache
  const slotResult = await query<{ slot_id: string; doctor_id: string; clinic_id: string }>(
    `SELECT slot_id, doctor_id, clinic_id FROM bookings WHERE id = $1`,
    [bookingId]
  );

  if (slotResult.rows[0]) {
    const { doctor_id, clinic_id } = slotResult.rows[0];
    await cacheDelPattern(`slots:${doctor_id}:${clinic_id}:*`);
  }

  logger.info('Booking confirmed', { bookingId });

  return { bookingReference: result.rows[0].booking_reference };
}

// ── GET PATIENT BOOKINGS ──────────────────────────────────────

export async function getPatientBookings(
  patientUserId: string,
  status:        'upcoming' | 'completed' | 'cancelled' | 'all',
  page:          number,
  perPage:       number
): Promise<{ bookings: Record<string, unknown>[]; total: number }> {

  const statusConditions: Record<string, string> = {
    upcoming:  `b.status IN ('confirmed','initiated') AND b.appointment_date >= CURRENT_DATE`,
    completed: `b.status = 'completed'`,
    cancelled: `b.status IN ('cancelled','rescheduled','no_show')`,
    all:       `b.status != 'initiated'`,
  };

  const condition = statusConditions[status] || statusConditions.all;

  const [countResult, bookingsResult] = await Promise.all([
    query<{ count: string }>(
      `SELECT COUNT(*) as count FROM bookings b
       JOIN patient_profiles pp ON pp.id = b.patient_id
       WHERE pp.user_id = $1 AND ${condition}`,
      [patientUserId]
    ),
    query(
      `SELECT
         b.id as booking_id,
         b.booking_reference,
         u_doc.full_name as doctor_name,
         u_doc.avatar_url as doctor_avatar_url,
         dp.primary_specialty as specialty,
         cp.name as clinic_name,
         b.appointment_start_at,
         b.status,
         b.fee_paise,
         b.payment_method,
         CASE WHEN b.appointment_start_at > NOW() AND b.status = 'confirmed' THEN TRUE ELSE FALSE END as can_cancel,
         CASE WHEN b.appointment_start_at > NOW() AND b.status = 'confirmed' THEN TRUE ELSE FALSE END as can_reschedule,
         CASE WHEN b.status = 'completed' AND b.review_id IS NULL THEN TRUE ELSE FALSE END as can_review
       FROM bookings b
       JOIN patient_profiles pp ON pp.id = b.patient_id
       JOIN doctor_profiles dp  ON dp.id = b.doctor_id
       JOIN users u_doc          ON u_doc.id = dp.user_id
       JOIN clinic_profiles cp   ON cp.id = b.clinic_id
       WHERE pp.user_id = $1 AND ${condition}
       ORDER BY b.appointment_start_at DESC
       LIMIT $2 OFFSET $3`,
      [patientUserId, perPage, (page - 1) * perPage]
    ),
  ]);

  return {
    bookings: bookingsResult.rows,
    total:    parseInt(countResult.rows[0]?.count || '0', 10),
  };
}

// ── GET BOOKING DETAIL ────────────────────────────────────────

export async function getBookingDetail(
  bookingId:    string,
  requesterUserId: string
): Promise<Record<string, unknown> | null> {

  const result = await query<BookingRow & Record<string, unknown>>(
    `SELECT
       b.*,
       u_patient.full_name as patient_name,
       u_patient.phone     as patient_phone,
       u_doc.full_name     as doctor_name,
       dp.primary_specialty,
       cp.name             as clinic_name,
       cp.address_line1    as clinic_address,
       cp.neighbourhood,
       cp.city
     FROM bookings b
     JOIN patient_profiles pp ON pp.id = b.patient_id
     JOIN users u_patient      ON u_patient.id = pp.user_id
     JOIN doctor_profiles dp   ON dp.id = b.doctor_id
     JOIN users u_doc          ON u_doc.id = dp.user_id
     JOIN clinic_profiles cp   ON cp.id = b.clinic_id
     WHERE b.id = $1`,
    [bookingId]
  );

  if (result.rowCount === 0) return null;

  const booking = result.rows[0];

  // Access control: only the patient, doctor, or clinic on this booking
  const hasAccess = await query<{ has_access: boolean }>(
    `SELECT (
       EXISTS (SELECT 1 FROM patient_profiles WHERE user_id = $1 AND id = $2)
       OR EXISTS (SELECT 1 FROM doctor_profiles  WHERE user_id = $1 AND id = $3)
       OR EXISTS (SELECT 1 FROM clinic_admins    WHERE user_id = $1 AND clinic_id = $4 AND is_active = TRUE)
       OR EXISTS (SELECT 1 FROM users            WHERE id = $1 AND role = 'platform_admin')
     ) as has_access`,
    [requesterUserId, booking.patient_id, booking.doctor_id, booking.clinic_id]
  );

  if (!hasAccess.rows[0]?.has_access) return null;

  return booking;
}

// ── CANCEL BOOKING ────────────────────────────────────────────

export async function cancelBooking(input: {
  bookingId:     string;
  cancelledBy:   'patient' | 'doctor' | 'clinic' | 'platform_admin';
  userIdString:  string;
  reason:        string;
  reasonDetail?: string;
}): Promise<{ cancellationId: string; isWithin2h: boolean }> {

  const result = await query<{ cancel_booking: string }>(
    `SELECT cancel_booking($1, $2, $3, $4, $5) as cancellation_id`,
    [
      input.bookingId,
      input.cancelledBy,
      input.userIdString,
      input.reason,
      input.reasonDetail || null,
    ]
  );

  const cancellationId = result.rows[0].cancel_booking;

  // Check if it was flagged
  const flagResult = await query<{ is_flagged: boolean }>(
    `SELECT is_flagged FROM bookings WHERE id = $1`,
    [input.bookingId]
  );

  // Invalidate slot cache
  const slotInfo = await query<{ slot_id: string; doctor_id: string; clinic_id: string }>(
    `SELECT slot_id, doctor_id, clinic_id FROM bookings WHERE id = $1`,
    [input.bookingId]
  );
  if (slotInfo.rows[0]) {
    const { doctor_id, clinic_id } = slotInfo.rows[0];
    await cacheDelPattern(`slots:${doctor_id}:${clinic_id}:*`);
  }

  logger.info('Booking cancelled', {
    bookingId:      input.bookingId,
    cancelledBy:    input.cancelledBy,
    cancellationId,
  });

  return {
    cancellationId,
    isWithin2h: flagResult.rows[0]?.is_flagged || false,
  };
}

// ── RESCHEDULE BOOKING ────────────────────────────────────────

export async function rescheduleBooking(input: {
  oldBookingId:    string;
  newSlotId:       string;
  rescheduledBy:   'patient' | 'doctor' | 'clinic';
  userIdString:    string;
  sessionId:       string;
}): Promise<{ newBookingId: string; newBookingReference: string }> {

  const result = await query<{ reschedule_booking: string }>(
    `SELECT reschedule_booking($1, $2, $3, $4, $5) as new_booking_id`,
    [
      input.oldBookingId,
      input.newSlotId,
      input.rescheduledBy,
      input.userIdString,
      input.sessionId,
    ]
  );

  const newBookingId = result.rows[0].reschedule_booking;

  const refResult = await query<{ booking_reference: string }>(
    `SELECT booking_reference FROM bookings WHERE id = $1`,
    [newBookingId]
  );

  // Invalidate slot cache
  const slotInfo = await query<{ doctor_id: string; clinic_id: string }>(
    `SELECT doctor_id, clinic_id FROM bookings WHERE id = $1`,
    [newBookingId]
  );
  if (slotInfo.rows[0]) {
    const { doctor_id, clinic_id } = slotInfo.rows[0];
    await cacheDelPattern(`slots:${doctor_id}:${clinic_id}:*`);
  }

  logger.info('Booking rescheduled', {
    oldBookingId: input.oldBookingId,
    newBookingId,
  });

  return {
    newBookingId,
    newBookingReference: refResult.rows[0].booking_reference,
  };
}

// ── SUBMIT REVIEW ─────────────────────────────────────────────

export async function submitReview(input: {
  bookingId:     string;
  patientUserId: string;
  rating:        number;
  reviewText?:   string;
  subRatings?:   Record<string, number>;
  submittedVia:  string;
}): Promise<{ reviewId: string }> {

  const result = await query<{ submit_review: string }>(
    `SELECT submit_review($1, $2, $3, $4, $5, $6) as review_id`,
    [
      input.bookingId,
      input.patientUserId,
      input.rating,
      input.reviewText    || null,
      JSON.stringify(input.subRatings || {}),
      input.submittedVia,
    ]
  );

  // Auto-publish after brief pending window
  // In production a background job handles this — for now publish immediately
  const reviewId = result.rows[0].submit_review;
  await query(
    `UPDATE reviews SET status = 'published', updated_at = NOW() WHERE id = $1`,
    [reviewId]
  );

  logger.info('Review submitted', { bookingId: input.bookingId, reviewId });

  return { reviewId };
}

// ── DOCTOR APPOINTMENTS ───────────────────────────────────────

export async function getDoctorAppointments(
  doctorProfileId: string,
  date:            string,
  clinicId?:       string,
  status?:         BookingStatus,
  page:            number = 1,
  perPage:         number = 20
): Promise<{ appointments: Record<string, unknown>[]; total: number }> {

  const conditions = [`b.doctor_id = $1`, `b.appointment_date = $2::date`];
  const values: unknown[] = [doctorProfileId, date];
  let idx = 3;

  if (clinicId) { conditions.push(`b.clinic_id = $${idx++}`);   values.push(clinicId); }
  if (status)   { conditions.push(`b.status = $${idx++}`);       values.push(status); }
  else          { conditions.push(`b.status IN ('confirmed','completed','no_show','cancelled')`); }

  const where = `WHERE ${conditions.join(' AND ')}`;

  const [countRes, apptRes] = await Promise.all([
    query<{ count: string }>(
      `SELECT COUNT(*) as count FROM bookings b ${where}`,
      values
    ),
    query(
      `SELECT
         b.id as booking_id,
         b.booking_reference,
         u_patient.full_name as patient_name,
         b.appointment_start_at,
         b.appointment_end_at,
         cp.name as clinic_name,
         b.status,
         b.reason_for_visit,
         b.fee_paise
       FROM bookings b
       JOIN patient_profiles pp ON pp.id = b.patient_id
       JOIN users u_patient      ON u_patient.id = pp.user_id
       JOIN clinic_profiles cp   ON cp.id = b.clinic_id
       ${where}
       ORDER BY b.appointment_start_at
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...values, perPage, (page - 1) * perPage]
    ),
  ]);

  return {
    appointments: apptRes.rows,
    total:        parseInt(countRes.rows[0]?.count || '0', 10),
  };
}

// ── DOCTOR DASHBOARD ──────────────────────────────────────────

export async function getDoctorDashboard(
  doctorProfileId: string
): Promise<Record<string, unknown>> {

  const today = new Date().toISOString().split('T')[0];

  const [todayCount, pendingApprovals, locationCount, profile] = await Promise.all([
    query<{ count: string; locations: string[] }>(
      `SELECT COUNT(*) as count,
              array_agg(DISTINCT cp.name) as locations
       FROM bookings b JOIN clinic_profiles cp ON cp.id = b.clinic_id
       WHERE b.doctor_id = $1 AND b.appointment_date = $2::date
         AND b.status IN ('confirmed','completed')`,
      [doctorProfileId, today]
    ),
    query<{ count: string }>(
      `SELECT COUNT(*) as count FROM schedule_requests
       WHERE doctor_id = $1 AND status = 'pending'`,
      [doctorProfileId]
    ),
    query<{ count: string }>(
      `SELECT COUNT(*) as count FROM doctor_clinic_links
       WHERE doctor_id = $1 AND status = 'active'`,
      [doctorProfileId]
    ),
    query<{ avg_rating: number; total_reviews: number }>(
      `SELECT avg_rating, total_reviews FROM doctor_profiles WHERE id = $1`,
      [doctorProfileId]
    ),
  ]);

  return {
    today: {
      date:               today,
      appointment_count:  parseInt(todayCount.rows[0]?.count || '0', 10),
      locations:          todayCount.rows[0]?.locations?.filter(Boolean) || [],
    },
    pending_approvals:    parseInt(pendingApprovals.rows[0]?.count || '0', 10),
    active_locations:     parseInt(locationCount.rows[0]?.count || '0', 10),
    avg_rating:           parseFloat(String(profile.rows[0]?.avg_rating || '0')),
    total_reviews:        profile.rows[0]?.total_reviews || 0,
    unread_notifications: 0,
  };
}
