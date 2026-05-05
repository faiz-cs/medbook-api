// src/modules/scheduling/scheduling.service.ts
// ============================================================
//  Scheduling Service
//  Handles the core 3-way sync mechanic:
//  Clinic proposes → Doctor approves → Slots go live
// ============================================================

import { query, transaction } from '../../config/database';
import { cacheDelPattern } from '../../config/redis';
import { logger } from '../../config/logger';
import { DayOfWeek, ScheduleRequestStatus } from '../../types';

// ── Types ─────────────────────────────────────────────────────

export interface ScheduleRequestRow {
  id:                     string;
  doctor_clinic_link_id:  string;
  doctor_id:              string;
  clinic_id:              string;
  requested_by:           string;
  status:                 ScheduleRequestStatus;
  proposed_days:          DayOfWeek[];
  proposed_start_time:    string;
  proposed_end_time:      string;
  slot_duration_minutes:  number;
  max_patients_per_day:   number;
  effective_from:         Date;
  effective_until:        Date | null;
  clinic_note:            string | null;
  viewed_at:              Date | null;
  responded_at:           Date | null;
  rejection_note:         string | null;
  counter_proposal:       Record<string, unknown> | null;
  reminder_sent_at:       Date | null;
  escalation_sent_at:     Date | null;
  resulting_rule_id:      string | null;
  created_at:             Date;
  updated_at:             Date;
}

export interface CreateScheduleRequestInput {
  doctorId:             string;
  clinicId:             string;
  requestedByUserId:    string;
  proposedDays:         DayOfWeek[];
  proposedStartTime:    string;
  proposedEndTime:      string;
  slotDurationMinutes:  number;
  maxPatientsPerDay:    number;
  effectiveFrom:        string;
  effectiveUntil?:      string;
  clinicNote?:          string;
}

// ── CLINIC: Create schedule request ───────────────────────────

export async function createScheduleRequest(
  input: CreateScheduleRequestInput
): Promise<ScheduleRequestRow> {

  // Verify the doctor-clinic link is active
  const linkResult = await query<{ id: string }>(
    `SELECT id FROM doctor_clinic_links
     WHERE doctor_id = $1 AND clinic_id = $2 AND status = 'active'`,
    [input.doctorId, input.clinicId]
  );

  if (linkResult.rowCount === 0) {
    throw new Error('LINK_NOT_ACTIVE');
  }

  const linkId = linkResult.rows[0].id;

  // Cancel any existing pending request for same doctor+clinic
  // (replacing with the new one)
  await query(
    `UPDATE schedule_requests
     SET status = 'cancelled', updated_at = NOW()
     WHERE doctor_id = $1 AND clinic_id = $2 AND status = 'pending'`,
    [input.doctorId, input.clinicId]
  );

  // Create the new request
  const result = await query<ScheduleRequestRow>(
    `INSERT INTO schedule_requests (
       doctor_clinic_link_id, doctor_id, clinic_id, requested_by,
       proposed_days, proposed_start_time, proposed_end_time,
       slot_duration_minutes, max_patients_per_day,
       effective_from, effective_until, clinic_note
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING *`,
    [
      linkId,
      input.doctorId,
      input.clinicId,
      input.requestedByUserId,
      input.proposedDays,
      input.proposedStartTime,
      input.proposedEndTime,
      input.slotDurationMinutes,
      input.maxPatientsPerDay,
      input.effectiveFrom,
      input.effectiveUntil || null,
      input.clinicNote     || null,
    ]
  );

  logger.info('Schedule request created', {
    requestId: result.rows[0].id,
    doctorId:  input.doctorId,
    clinicId:  input.clinicId,
  });

  return result.rows[0];
}

// ── DOCTOR: Get pending requests ──────────────────────────────

export async function getDoctorScheduleRequests(
  doctorProfileId: string,
  status: ScheduleRequestStatus | 'all' = 'pending'
): Promise<Array<ScheduleRequestRow & {
  clinic_name: string;
  hours_since_received: number;
}>> {

  const statusCondition = status === 'all'
    ? ''
    : `AND sr.status = '${status}'`;

  const result = await query<ScheduleRequestRow & {
    clinic_name:          string;
    hours_since_received: number;
  }>(
    `SELECT sr.*,
            cp.name as clinic_name,
            EXTRACT(EPOCH FROM (NOW() - sr.created_at))/3600 as hours_since_received
     FROM schedule_requests sr
     JOIN clinic_profiles cp ON cp.id = sr.clinic_id
     WHERE sr.doctor_id = $1 ${statusCondition}
     ORDER BY sr.created_at DESC`,
    [doctorProfileId]
  );

  return result.rows;
}

// ── DOCTOR: Mark request as viewed ────────────────────────────

export async function markRequestViewed(requestId: string): Promise<void> {
  await query(
    `UPDATE schedule_requests
     SET viewed_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND viewed_at IS NULL`,
    [requestId]
  );
}

// ── DOCTOR: Approve request ───────────────────────────────────
// Calls the atomic approve_schedule_request() DB function we built in Phase 3

export async function approveScheduleRequest(
  requestId:      string,
  doctorUserId:   string,
  doctorProfileId: string
): Promise<{ ruleId: string; slotsGenerated: number }> {

  // Verify this request belongs to this doctor
  const reqResult = await query<ScheduleRequestRow>(
    `SELECT * FROM schedule_requests WHERE id = $1 AND doctor_id = $2 AND status = 'pending'`,
    [requestId, doctorProfileId]
  );

  if (reqResult.rowCount === 0) {
    throw new Error('REQUEST_NOT_FOUND');
  }

  // Call the atomic DB function
  const result = await query<{ approve_schedule_request: string }>(
    `SELECT approve_schedule_request($1, $2) as rule_id`,
    [requestId, doctorUserId]
  );

  const ruleId = result.rows[0].approve_schedule_request;

  // Count slots generated for this rule
  const slotsResult = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM time_slots WHERE schedule_rule_id = $1`,
    [ruleId]
  );
  const slotsGenerated = parseInt(slotsResult.rows[0]?.count || '0', 10);

  // Invalidate doctor's slot cache
  await cacheDelPattern(`slots:${doctorProfileId}:*`);
  await cacheDelPattern(`search:*`);

  logger.info('Schedule request approved', {
    requestId,
    ruleId,
    slotsGenerated,
    doctorProfileId,
  });

  return { ruleId, slotsGenerated };
}

// ── DOCTOR: Reject request ────────────────────────────────────

export async function rejectScheduleRequest(
  requestId:      string,
  doctorProfileId: string,
  rejectionNote?: string
): Promise<void> {

  const result = await query(
    `UPDATE schedule_requests
     SET status = 'rejected',
         rejection_note = $3,
         responded_at = NOW(),
         updated_at = NOW()
     WHERE id = $1 AND doctor_id = $2 AND status = 'pending'
     RETURNING id`,
    [requestId, doctorProfileId, rejectionNote || null]
  );

  if (result.rowCount === 0) {
    throw new Error('REQUEST_NOT_FOUND');
  }

  logger.info('Schedule request rejected', { requestId, doctorProfileId });
}

// ── DOCTOR: Counter-propose ────────────────────────────────────

export async function counterProposeSchedule(
  requestId:      string,
  doctorProfileId: string,
  proposal: {
    proposed_days:        DayOfWeek[];
    proposed_start_time:  string;
    proposed_end_time:    string;
    note?:                string;
  }
): Promise<void> {

  const result = await query(
    `UPDATE schedule_requests
     SET status = 'counter_proposed',
         counter_proposal = $3,
         responded_at = NOW(),
         updated_at = NOW()
     WHERE id = $1 AND doctor_id = $2 AND status = 'pending'
     RETURNING id`,
    [requestId, doctorProfileId, JSON.stringify(proposal)]
  );

  if (result.rowCount === 0) {
    throw new Error('REQUEST_NOT_FOUND');
  }
}

// ── DOCTOR: Get active schedules (My Schedule screen) ─────────

export async function getDoctorSchedule(
  doctorProfileId: string
): Promise<Array<{
  rule_id:              string;
  clinic_name:          string;
  clinic_id:            string;
  neighbourhood:        string | null;
  city:                 string;
  active_days:          DayOfWeek[];
  start_time:           string;
  end_time:             string;
  slot_duration_minutes: number;
  max_patients_per_day: number;
  effective_from:       Date;
  effective_until:      Date | null;
  status:               string;
}>> {
  const result = await query(
    `SELECT
       sr.id as rule_id,
       cp.name as clinic_name,
       cp.id as clinic_id,
       cp.neighbourhood,
       cp.city,
       sr.active_days,
       sr.start_time,
       sr.end_time,
       sr.slot_duration_minutes,
       sr.max_patients_per_day,
       sr.effective_from,
       sr.effective_until,
       CASE WHEN sr.is_active THEN 'live' ELSE 'inactive' END as status
     FROM schedule_rules sr
     JOIN clinic_profiles cp ON cp.id = sr.clinic_id
     WHERE sr.doctor_id = $1 AND sr.is_active = TRUE
     ORDER BY cp.name`,
    [doctorProfileId]
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return result.rows as any[];
}

// ── DOCTOR: Block dates ────────────────────────────────────────

export async function blockDates(
  doctorProfileId: string,
  createdByUserId: string,
  data: {
    block_from: string;
    block_until: string;
    reason:     string;
    note?:      string;
    clinic_id?: string;
  }
): Promise<{
  blockedDateId:    string;
  affectedSlots:    number;
  affectedBookings: number;
}> {
  return transaction(async (client) => {

    // Insert blocked date record
    const blockResult = await client.query<{ id: string }>(
      `INSERT INTO blocked_dates
         (doctor_id, clinic_id, block_from, block_until, reason, note, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        doctorProfileId,
        data.clinic_id  || null,
        data.block_from,
        data.block_until,
        data.reason,
        data.note       || null,
        createdByUserId,
      ]
    );
    const blockedDateId = blockResult.rows[0].id;

    // Block all available slots in the date range
    const slotsResult = await client.query<{ count: string }>(
      `WITH blocked AS (
         UPDATE time_slots
         SET status = 'blocked', updated_at = NOW()
         WHERE doctor_id = $1
           AND slot_date BETWEEN $2::date AND $3::date
           AND status = 'available'
           AND ($4::uuid IS NULL OR clinic_id = $4::uuid)
         RETURNING id
       )
       SELECT COUNT(*) as count FROM blocked`,
      [doctorProfileId, data.block_from, data.block_until, data.clinic_id || null]
    );
    const affectedSlots = parseInt(slotsResult.rows[0]?.count || '0', 10);

    // Count confirmed bookings in this range (patients will need notification)
    const bookingsResult = await client.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM bookings
       WHERE doctor_id = $1
         AND appointment_date BETWEEN $2::date AND $3::date
         AND status = 'confirmed'
         AND ($4::uuid IS NULL OR clinic_id = $4::uuid)`,
      [doctorProfileId, data.block_from, data.block_until, data.clinic_id || null]
    );
    const affectedBookings = parseInt(bookingsResult.rows[0]?.count || '0', 10);

    // Mark the block as slot-updated
    await client.query(
      `UPDATE blocked_dates
       SET slots_updated = TRUE, slots_updated_at = NOW()
       WHERE id = $1`,
      [blockedDateId]
    );

    // Invalidate slot cache for this doctor
    await cacheDelPattern(`slots:${doctorProfileId}:*`);

    logger.info('Doctor blocked dates', {
      doctorProfileId,
      blockFrom:       data.block_from,
      blockUntil:      data.block_until,
      affectedSlots,
      affectedBookings,
    });

    return { blockedDateId, affectedSlots, affectedBookings };
  });
}

// ── CLINIC: Get schedule requests sent by clinic ───────────────

export async function getClinicScheduleRequests(
  clinicId: string
): Promise<Array<ScheduleRequestRow & {
  doctor_name:                string;
  hours_remaining_before_escalation: number;
}>> {

  const result = await query(
    `SELECT sr.*,
            u.full_name as doctor_name,
            GREATEST(0,
              72 - EXTRACT(EPOCH FROM (NOW() - sr.created_at))/3600
            ) as hours_remaining_before_escalation
     FROM schedule_requests sr
     JOIN doctor_profiles dp ON dp.id = sr.doctor_id
     JOIN users u ON u.id = dp.user_id
     WHERE sr.clinic_id = $1
     ORDER BY sr.created_at DESC
     LIMIT 50`,
    [clinicId]
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return result.rows as any[];
}

// ── DOCTOR: Get linked clinics ─────────────────────────────────

export async function getDoctorLinkedClinics(
  doctorProfileId: string
): Promise<Array<{
  link_id:          string;
  clinic_id:        string;
  clinic_name:      string;
  neighbourhood:    string | null;
  city:             string;
  link_status:      string;
  schedule_status:  string;
  linked_since:     Date;
}>> {

  const result = await query(
    `SELECT
       dcl.id as link_id,
       cp.id as clinic_id,
       cp.name as clinic_name,
       cp.neighbourhood,
       cp.city,
       dcl.status as link_status,
       CASE
         WHEN EXISTS (
           SELECT 1 FROM schedule_rules sr
           WHERE sr.doctor_id = dcl.doctor_id
             AND sr.clinic_id = dcl.clinic_id
             AND sr.is_active = TRUE
         ) THEN 'live'
         WHEN EXISTS (
           SELECT 1 FROM schedule_requests sreq
           WHERE sreq.doctor_id = dcl.doctor_id
             AND sreq.clinic_id = dcl.clinic_id
             AND sreq.status = 'pending'
         ) THEN 'pending'
         ELSE 'none'
       END as schedule_status,
       dcl.created_at as linked_since
     FROM doctor_clinic_links dcl
     JOIN clinic_profiles cp ON cp.id = dcl.clinic_id
     WHERE dcl.doctor_id = $1
       AND dcl.status = 'active'
     ORDER BY cp.name`,
    [doctorProfileId]
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return result.rows as any[];
}

// ── SLOT: Get available slots for a doctor at a clinic ────────

export async function getAvailableSlots(
  doctorProfileId: string,
  clinicId:        string,
  fromDate:        string,
  toDate:          string
): Promise<Record<string, Array<{
  slot_id:          string;
  start_time:       string;
  end_time:         string;
  start_at:         string;
  status:           string;
  duration_minutes: number;
}>>> {

  type SlotItem = {
    slot_id: string; start_time: string; end_time: string;
    start_at: string; status: string; duration_minutes: number;
  };

  const cacheKey = `slots:${doctorProfileId}:${clinicId}:${fromDate}:${toDate}`;
  const { cacheGet, cacheSet } = await import('../../config/redis');
  const cached = await cacheGet<Record<string, SlotItem[]>>(cacheKey);
  if (cached) return cached;

  const result = await query<{
    slot_id:          string;
    slot_date:        string;
    slot_start_time:  string;
    slot_end_time:    string;
    slot_start_at:    string;
    status:           string;
    duration_minutes: number;
  }>(
    `SELECT
       id as slot_id,
       slot_date::text,
       slot_start_time::text,
       slot_end_time::text,
       slot_start_at::text,
       status,
       duration_minutes
     FROM time_slots
     WHERE doctor_id = $1
       AND clinic_id = $2
       AND slot_date BETWEEN $3::date AND $4::date
       AND status = 'available'
       AND slot_start_at > NOW()
     ORDER BY slot_date, slot_start_time`,
    [doctorProfileId, clinicId, fromDate, toDate]
  );

  // Group by date
  const slotsByDate: Record<string, SlotItem[]> = {};

  result.rows.forEach(row => {
    const dateKey = row.slot_date;
    if (!slotsByDate[dateKey]) slotsByDate[dateKey] = [];
    slotsByDate[dateKey].push({
      slot_id:          row.slot_id,
      start_time:       row.slot_start_time,
      end_time:         row.slot_end_time,
      start_at:         row.slot_start_at,
      status:           row.status,
      duration_minutes: row.duration_minutes,
    });
  });

  // Cache for 60 seconds
  await cacheSet(cacheKey, slotsByDate, 60);

  return slotsByDate;
}
