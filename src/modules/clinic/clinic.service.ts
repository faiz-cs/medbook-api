// src/modules/clinic/clinic.service.ts
// ============================================================
//  Clinic Service
//  Doctor linking, booking queue management, clinic dashboard
// ============================================================

import { query, transaction } from '../../config/database';
import { logger } from '../../config/logger';

// ── DOCTOR LINKING ────────────────────────────────────────────

export async function sendDoctorLinkRequest(
  clinicId:        string,
  requestedByUserId: string,
  nmcNumber:       string,
  requestNote?:    string
): Promise<{ linkId: string; doctorName: string }> {

  // Find the doctor by NMC number
  const doctorResult = await query<{ id: string; user_id: string; full_name: string }>(
    `SELECT dp.id, dp.user_id, u.full_name
     FROM doctor_profiles dp
     JOIN users u ON u.id = dp.user_id
     WHERE dp.nmc_number = $1
       AND dp.verification_status = 'approved'
       AND dp.is_visible = TRUE`,
    [nmcNumber]
  );

  if (doctorResult.rowCount === 0) {
    throw new Error('DOCTOR_NOT_FOUND');
  }

  const doctor = doctorResult.rows[0];

  // Check if already linked or pending
  const existingLink = await query<{ id: string; status: string }>(
    `SELECT id, status FROM doctor_clinic_links
     WHERE doctor_id = $1 AND clinic_id = $2`,
    [doctor.id, clinicId]
  );

  if (existingLink.rowCount && existingLink.rowCount > 0) {
    const existing = existingLink.rows[0];
    if (existing.status === 'active')  throw new Error('ALREADY_LINKED');
    if (existing.status === 'pending') throw new Error('LINK_ALREADY_PENDING');

    // Reactivate a removed link
    if (existing.status === 'removed' || existing.status === 'rejected') {
      await query(
        `UPDATE doctor_clinic_links
         SET status = 'pending', initiated_by = $3, request_note = $4,
             responded_at = NULL, rejection_note = NULL, removed_at = NULL,
             updated_at = NOW()
         WHERE id = $1`,
        [existing.id, doctor.id, requestedByUserId, requestNote || null]
      );
      return { linkId: existing.id, doctorName: doctor.full_name };
    }
  }

  // Create new link request
  const result = await query<{ id: string }>(
    `INSERT INTO doctor_clinic_links
       (doctor_id, clinic_id, status, initiated_by, request_note)
     VALUES ($1, $2, 'pending', $3, $4)
     RETURNING id`,
    [doctor.id, clinicId, requestedByUserId, requestNote || null]
  );

  logger.info('Doctor link request sent', {
    clinicId,
    doctorId: doctor.id,
    linkId:   result.rows[0].id,
  });

  return { linkId: result.rows[0].id, doctorName: doctor.full_name };
}

export async function inviteDoctorBySms(
  clinicId:    string,
  phone:       string,
  doctorName?: string
): Promise<void> {
  // In Phase 1: log the invite. Phase 2: trigger MSG91 SMS
  logger.info('Doctor invite via SMS', { clinicId, phone: phone.slice(0, 7) + '****', doctorName });
  // TODO: trigger notification service to send invite SMS
}

export async function removeDoctorLink(
  linkId:    string,
  clinicId:  string,
  removedBy: string
): Promise<{ affectedBookings: number }> {
  return transaction(async (client) => {
    // Verify link belongs to this clinic
    const linkResult = await client.query<{ id: string; doctor_id: string }>(
      `SELECT id, doctor_id FROM doctor_clinic_links
       WHERE id = $1 AND clinic_id = $2 AND status = 'active'
       FOR UPDATE`,
      [linkId, clinicId]
    );

    if (linkResult.rowCount === 0) throw new Error('LINK_NOT_FOUND');

    const { doctor_id } = linkResult.rows[0];

    // Count upcoming bookings affected
    const bookingsResult = await client.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM bookings
       WHERE doctor_id = $1 AND clinic_id = $2
         AND status = 'confirmed'
         AND appointment_date >= CURRENT_DATE`,
      [doctor_id, clinicId]
    );
    const affectedBookings = parseInt(bookingsResult.rows[0]?.count || '0', 10);

    // Deactivate all schedule rules for this doctor at this clinic
    await client.query(
      `UPDATE schedule_rules
       SET is_active = FALSE, deactivated_at = NOW(), deactivated_by = $3
       WHERE doctor_id = $1 AND clinic_id = $2 AND is_active = TRUE`,
      [doctor_id, clinicId, removedBy]
    );

    // Mark the link as removed
    await client.query(
      `UPDATE doctor_clinic_links
       SET status = 'removed', removed_at = NOW(), removed_by = $3, updated_at = NOW()
       WHERE id = $1`,
      [linkId, clinicId, removedBy]
    );

    return { affectedBookings };
  });
}

export async function getClinicDoctors(clinicId: string): Promise<Array<{
  link_id:          string;
  doctor_profile_id: string;
  doctor_name:      string;
  specialty:        string;
  avatar_url:       string | null;
  link_status:      string;
  schedule_status:  string;
  schedule_summary: string | null;
  todays_bookings:  number;
}>> {
  const result = await query(
    `SELECT
       dcl.id as link_id,
       dp.id as doctor_profile_id,
       u.full_name as doctor_name,
       dp.primary_specialty as specialty,
       u.avatar_url,
       dcl.status as link_status,
       CASE
         WHEN sr_active.id IS NOT NULL THEN 'live'
         WHEN sr_pending.id IS NOT NULL THEN 'pending'
         ELSE 'none'
       END as schedule_status,
       CASE
         WHEN sr_active.id IS NOT NULL THEN
           array_to_string(sr_active.active_days, ', ') || ' ' ||
           sr_active.start_time || '–' || sr_active.end_time
         ELSE NULL
       END as schedule_summary,
       COALESCE(today_bookings.cnt, 0) as todays_bookings
     FROM doctor_clinic_links dcl
     JOIN doctor_profiles dp ON dp.id = dcl.doctor_id
     JOIN users u ON u.id = dp.user_id
     LEFT JOIN LATERAL (
       SELECT id, active_days, start_time, end_time
       FROM schedule_rules
       WHERE doctor_id = dcl.doctor_id AND clinic_id = $1 AND is_active = TRUE
       LIMIT 1
     ) sr_active ON TRUE
     LEFT JOIN LATERAL (
       SELECT id FROM schedule_requests
       WHERE doctor_id = dcl.doctor_id AND clinic_id = $1 AND status = 'pending'
       LIMIT 1
     ) sr_pending ON TRUE
     LEFT JOIN LATERAL (
       SELECT COUNT(*) as cnt FROM bookings
       WHERE doctor_id = dcl.doctor_id AND clinic_id = $1
         AND appointment_date = CURRENT_DATE AND status IN ('confirmed','completed')
     ) today_bookings ON TRUE
     WHERE dcl.clinic_id = $1
     ORDER BY dcl.status, u.full_name`,
    [clinicId]
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return result.rows as any[];
}

// ── CLINIC DASHBOARD ──────────────────────────────────────────

export async function getClinicDashboardStats(clinicId: string): Promise<{
  clinic_name:               string;
  today:                     Record<string, number>;
  active_doctors:            number;
  pending_schedule_requests: number;
  unread_notifications:      number;
}> {
  const [clinicResult, statsResult, doctorCount, pendingSchedules] = await Promise.all([
    query<{ name: string }>(`SELECT name FROM clinic_profiles WHERE id = $1`, [clinicId]),
    query<Record<string, string>>(
      `SELECT
         COUNT(*) FILTER (WHERE status IN ('confirmed','completed','cancelled','no_show')) as total,
         COUNT(*) FILTER (WHERE status = 'confirmed')  as confirmed,
         COUNT(*) FILTER (WHERE status = 'completed')  as completed,
         COUNT(*) FILTER (WHERE status = 'cancelled')  as cancelled,
         COUNT(*) FILTER (WHERE status = 'no_show')    as no_shows
       FROM bookings
       WHERE clinic_id = $1 AND appointment_date = CURRENT_DATE`,
      [clinicId]
    ),
    query<{ count: string }>(
      `SELECT COUNT(*) as count FROM doctor_clinic_links WHERE clinic_id = $1 AND status = 'active'`,
      [clinicId]
    ),
    query<{ count: string }>(
      `SELECT COUNT(*) as count FROM schedule_requests WHERE clinic_id = $1 AND status = 'pending'`,
      [clinicId]
    ),
  ]);

  const stats = statsResult.rows[0] || {};
  return {
    clinic_name: clinicResult.rows[0]?.name || '',
    today: {
      total_bookings:  parseInt(stats['total']     || '0', 10),
      confirmed:       parseInt(stats['confirmed'] || '0', 10),
      completed:       parseInt(stats['completed'] || '0', 10),
      cancelled:       parseInt(stats['cancelled'] || '0', 10),
      no_shows:        parseInt(stats['no_shows']  || '0', 10),
    },
    active_doctors:            parseInt(doctorCount.rows[0]?.count    || '0', 10),
    pending_schedule_requests: parseInt(pendingSchedules.rows[0]?.count || '0', 10),
    unread_notifications:      0, // TODO: wire up notification count
  };
}

// ── TODAY'S QUEUE ─────────────────────────────────────────────

export async function getTodaysQueue(
  clinicId:  string,
  date?:     string,
  doctorId?: string
): Promise<Array<Record<string, unknown>>> {
  const targetDate = date || new Date().toISOString().split('T')[0];
  const doctorFilter = doctorId ? `AND b.doctor_id = '${doctorId}'` : '';

  const result = await query(
    `SELECT
       b.id as booking_id,
       b.booking_reference,
       u_patient.full_name as patient_name,
       u_patient.phone as patient_phone,
       u_doctor.full_name as doctor_name,
       dp.primary_specialty,
       b.appointment_start_at,
       b.appointment_end_at,
       b.status,
       b.reason_for_visit,
       b.payment_method,
       b.fee_paise,
       b.is_flagged,
       ROW_NUMBER() OVER (
         PARTITION BY b.clinic_id, b.appointment_date
         ORDER BY b.appointment_start_at
       ) as queue_position
     FROM bookings b
     JOIN patient_profiles pp ON pp.id = b.patient_id
     JOIN users u_patient ON u_patient.id = pp.user_id
     JOIN doctor_profiles dp ON dp.id = b.doctor_id
     JOIN users u_doctor ON u_doctor.id = dp.user_id
     WHERE b.clinic_id = $1
       AND b.appointment_date = $2::date
       AND b.status IN ('confirmed','completed','no_show')
       ${doctorFilter}
     ORDER BY b.appointment_start_at`,
    [clinicId, targetDate]
  );

  return result.rows;
}

export async function markBookingComplete(
  bookingId: string,
  clinicId:  string,
  byUserId:  string
): Promise<void> {
  const result = await query(
    `UPDATE bookings
     SET status = 'completed', completed_at = NOW(), completed_by = $3, updated_at = NOW()
     WHERE id = $1 AND clinic_id = $2 AND status = 'confirmed'`,
    [bookingId, clinicId, byUserId]
  );

  if (result.rowCount === 0) throw new Error('BOOKING_NOT_FOUND');

  // Increment doctor's total appointments
  await query(
    `UPDATE doctor_profiles dp
     SET total_appointments = total_appointments + 1, updated_at = NOW()
     FROM bookings b
     WHERE b.id = $1 AND dp.id = b.doctor_id`,
    [bookingId]
  );
}
