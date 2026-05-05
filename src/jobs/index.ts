// src/jobs/index.ts
// ============================================================
//  Background Jobs — run on schedule using node-cron
//  These are the 9 jobs defined in the Phase 3 & 4 schema
// ============================================================

import cron from 'node-cron';
import { query } from '../config/database';
import { logger } from '../config/logger';
import {
  notifyBookingReminder,
  notifyReviewRequest,
} from '../modules/notification/notification.service';

// ── Job runner wrapper ─────────────────────────────────────────
// Catches errors so one job failure doesn't crash the process
async function runJob(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    logger.debug(`Running job: ${name}`);
    await fn();
  } catch (err) {
    logger.error(`Job failed: ${name}`, { err });
  }
}

// ── JOB 1: Nightly slot generation (00:30 IST = 19:00 UTC) ───
// Generates slots 60 days ahead for all active schedule rules
export function startSlotGenerationJob(): void {
  cron.schedule('0 19 * * *', async () => {
    await runJob('slot-generation', async () => {
      const rules = await query<{ id: string }>(
        `SELECT id FROM schedule_rules WHERE is_active = TRUE`
      );
      let totalGenerated = 0;
      for (const rule of rules.rows) {
        const result = await query<{ generate_slots_for_rule: number }>(
          `SELECT generate_slots_for_rule($1) as count`,
          [rule.id]
        );
        totalGenerated += result.rows[0]?.generate_slots_for_rule || 0;
      }
      logger.info('Slot generation complete', {
        rules:          rules.rows.length,
        slotsGenerated: totalGenerated,
      });
    });
  }, { timezone: 'UTC' });
}

// ── JOB 2: Release expired slot locks (every minute) ─────────
export function startLockExpiryJob(): void {
  cron.schedule('* * * * *', async () => {
    await runJob('lock-expiry', async () => {
      const result = await query<{ release_expired_locks: number }>(
        `SELECT release_expired_locks() as released`
      );
      const released = result.rows[0]?.release_expired_locks || 0;
      if (released > 0) logger.info(`Released ${released} expired slot locks`);
    });
  });
}

// ── JOB 3: Expire past slots (every 15 minutes) ───────────────
export function startSlotExpiryJob(): void {
  cron.schedule('*/15 * * * *', async () => {
    await runJob('slot-expiry', async () => {
      const result = await query<{ expire_past_slots: number }>(
        `SELECT expire_past_slots() as expired`
      );
      const expired = result.rows[0]?.expire_past_slots || 0;
      if (expired > 0) logger.info(`Expired ${expired} past slots`);
    });
  });
}

// ── JOB 4: Schedule request escalation (every hour) ──────────
export function startEscalationJob(): void {
  cron.schedule('0 * * * *', async () => {
    await runJob('schedule-escalation', async () => {
      // Send 48h reminder to doctors who haven't responded
      const reminder48 = await query<{ id: string }>(
        `UPDATE schedule_requests
         SET reminder_sent_at = NOW(), updated_at = NOW()
         WHERE status = 'pending'
           AND reminder_sent_at IS NULL
           AND created_at < NOW() - INTERVAL '48 hours'
         RETURNING id`
      );
      if (reminder48.rowCount && reminder48.rowCount > 0) {
        logger.info(`Sent 48h reminder for ${reminder48.rowCount} schedule requests`);
        // TODO: trigger notification for each request
      }

      // Escalate 72h unresponded requests
      const expired72 = await query(
        `UPDATE schedule_requests
         SET status = 'expired', escalation_sent_at = NOW(), updated_at = NOW()
         WHERE status = 'pending'
           AND created_at < NOW() - INTERVAL '72 hours'
         RETURNING id, clinic_id`
      );
      if (expired72.rowCount && expired72.rowCount > 0) {
        logger.info(`Expired ${expired72.rowCount} unresponded schedule requests`);
        // TODO: notify each clinic
      }
    });
  });
}

// ── JOB 5: Auto-complete appointments (every 30 min) ─────────
export function startAutoCompleteJob(): void {
  cron.schedule('*/30 * * * *', async () => {
    await runJob('auto-complete', async () => {
      const result = await query<{ id: string }>(
        `SELECT id FROM bookings
         WHERE status = 'confirmed'
           AND appointment_end_at < NOW() - INTERVAL '30 minutes'`
      );
      for (const booking of result.rows) {
        await query(
          `SELECT complete_booking($1, NULL)`,
          [booking.id]
        );
      }
      if (result.rows.length > 0) {
        logger.info(`Auto-completed ${result.rows.length} appointments`);
      }
    });
  });
}

// ── JOB 6: Send 24h appointment reminders (every hour) ────────
export function startReminder24hJob(): void {
  cron.schedule('5 * * * *', async () => {
    await runJob('reminder-24h', async () => {
      const result = await query<{ id: string }>(
        `SELECT id FROM bookings
         WHERE status = 'confirmed'
           AND reminder_24h_sent_at IS NULL
           AND appointment_start_at BETWEEN NOW() + INTERVAL '23 hours'
                                        AND NOW() + INTERVAL '25 hours'`
      );
      for (const booking of result.rows) {
        await notifyBookingReminder(booking.id, '24h');
      }
      if (result.rows.length > 0) {
        logger.info(`Sent 24h reminders for ${result.rows.length} bookings`);
      }
    });
  });
}

// ── JOB 7: Send 2h appointment reminders (every 15 min) ───────
export function startReminder2hJob(): void {
  cron.schedule('*/15 * * * *', async () => {
    await runJob('reminder-2h', async () => {
      const result = await query<{ id: string }>(
        `SELECT id FROM bookings
         WHERE status = 'confirmed'
           AND reminder_2h_sent_at IS NULL
           AND appointment_start_at BETWEEN NOW() + INTERVAL '105 minutes'
                                        AND NOW() + INTERVAL '135 minutes'`
      );
      for (const booking of result.rows) {
        await notifyBookingReminder(booking.id, '2h');
      }
      if (result.rows.length > 0) {
        logger.info(`Sent 2h reminders for ${result.rows.length} bookings`);
      }
    });
  });
}

// ── JOB 8: Request post-visit reviews (every hour) ────────────
export function startReviewRequestJob(): void {
  cron.schedule('10 * * * *', async () => {
    await runJob('review-requests', async () => {
      const result = await query<{ id: string; patient_user_id: string }>(
        `SELECT b.id, u.id as patient_user_id
         FROM bookings b
         JOIN patient_profiles pp ON pp.id = b.patient_id
         JOIN users u ON u.id = pp.user_id
         WHERE b.status = 'completed'
           AND b.review_requested_at IS NULL
           AND b.completed_at < NOW() - INTERVAL '1 hour'
           AND b.review_id IS NULL`
      );
      for (const booking of result.rows) {
        await notifyReviewRequest(booking.id, booking.patient_user_id);
      }
      if (result.rows.length > 0) {
        logger.info(`Sent review requests for ${result.rows.length} bookings`);
      }
    });
  });
}

// ── JOB 9: Auto no-show detection (every hour) ────────────────
export function startNoShowJob(): void {
  cron.schedule('20 * * * *', async () => {
    await runJob('no-show-detection', async () => {
      const result = await query(
        `UPDATE bookings
         SET status = 'no_show', no_show_recorded_at = NOW(), updated_at = NOW()
         WHERE status = 'confirmed'
           AND appointment_end_at < NOW() - INTERVAL '2 hours'
         RETURNING id`
      );
      if (result.rowCount && result.rowCount > 0) {
        logger.info(`Marked ${result.rowCount} bookings as no_show`);
      }
    });
  });
}

// ── Start all jobs ─────────────────────────────────────────────
export function startAllJobs(): void {
  startSlotGenerationJob();
  startLockExpiryJob();
  startSlotExpiryJob();
  startEscalationJob();
  startAutoCompleteJob();
  startReminder24hJob();
  startReminder2hJob();
  startReviewRequestJob();
  startNoShowJob();

  logger.info('✅ All background jobs started', {
    jobs: [
      'slot-generation (00:30 IST)',
      'lock-expiry (every minute)',
      'slot-expiry (every 15 min)',
      'escalation (every hour)',
      'auto-complete (every 30 min)',
      'reminder-24h (every hour)',
      'reminder-2h (every 15 min)',
      'review-requests (every hour)',
      'no-show (every hour)',
    ],
  });
}
