// src/modules/admin/admin.routes.ts
// ============================================================
//  Admin Routes — platform_admin role only
//  Verification queue, flags, reviews, analytics
// ============================================================

import { Router, Request, Response, RequestHandler } from 'express';
import { authenticate, requireRole } from '../../middleware';
import { sendSuccess, Errors, getPaginationParams } from '../../utils/response';
import { query } from '../../config/database';
import { logger } from '../../config/logger';

const router = Router();

// All admin routes require platform_admin role
const adminAuth = [authenticate as RequestHandler, requireRole('platform_admin') as RequestHandler];

// ── GET /v1/admin/dashboard ───────────────────────────────────
router.get('/admin/dashboard', ...adminAuth,
  async (_req: Request, res: Response): Promise<void> => {
    const result = await query(`SELECT * FROM platform_summary_view`);
    sendSuccess(res, result.rows[0] || {});
  }
);

// ── DOCTOR VERIFICATIONS ──────────────────────────────────────

router.get('/admin/verifications/doctors', ...adminAuth,
  async (req: Request, res: Response): Promise<void> => {
    const status = String(req.query['status'] || 'submitted');
    const { page, per_page, offset } = getPaginationParams(req.query.page, req.query.per_page);

    const [countRes, dataRes] = await Promise.all([
      query<{count:string}>(
        `SELECT COUNT(*) as count FROM doctor_profiles WHERE verification_status = $1`,
        [status]
      ),
      query(
        `SELECT dp.id as doctor_profile_id, u.full_name as doctor_name,
                dp.nmc_number, dp.primary_specialty, dp.nmc_document_url,
                dp.verification_status, dp.created_at as submitted_at,
                EXTRACT(EPOCH FROM (NOW() - dp.updated_at))/3600 as hours_waiting
         FROM doctor_profiles dp
         JOIN users u ON u.id = dp.user_id
         WHERE dp.verification_status = $1
         ORDER BY dp.created_at ASC
         LIMIT $2 OFFSET $3`,
        [status, per_page, offset]
      ),
    ]);

    const total = parseInt(countRes.rows[0]?.count || '0', 10);
    sendSuccess(res, { verifications: dataRes.rows }, 200, { page, per_page, total });
  }
);

router.post('/admin/verifications/doctors/:id/approve', ...adminAuth,
  async (req: Request, res: Response): Promise<void> => {
    const id = String(req.params['id']);
    await query(
      `UPDATE doctor_profiles
       SET verification_status = 'approved', verified_by = $2, verified_at = NOW(),
           is_visible = TRUE, updated_at = NOW()
       WHERE id = $1`,
      [id, req.user!.userId]
    );
    // Activate user account
    await query(
      `UPDATE users SET status = 'active', updated_at = NOW()
       WHERE id = (SELECT user_id FROM doctor_profiles WHERE id = $1)`,
      [id]
    );
    const name = await query<{full_name:string}>(
      `SELECT u.full_name FROM doctor_profiles dp JOIN users u ON u.id = dp.user_id WHERE dp.id = $1`,
      [id]
    );
    logger.info('Doctor approved', { doctorProfileId: id, approvedBy: req.user!.userId });
    sendSuccess(res, { doctor_profile_id: id, status: 'approved', profile_live: true, doctor_name: name.rows[0]?.full_name });
  }
);

router.post('/admin/verifications/doctors/:id/reject', ...adminAuth,
  async (req: Request, res: Response): Promise<void> => {
    const id = String(req.params['id']);
    const { rejection_reason } = req.body as { rejection_reason: string };
    await query(
      `UPDATE doctor_profiles
       SET verification_status = 'rejected', verified_by = $2,
           rejection_reason = $3, updated_at = NOW()
       WHERE id = $1`,
      [id, req.user!.userId, rejection_reason]
    );
    sendSuccess(res, { doctor_profile_id: id, status: 'rejected' });
  }
);

// ── CLINIC VERIFICATIONS ──────────────────────────────────────

router.get('/admin/verifications/clinics', ...adminAuth,
  async (req: Request, res: Response): Promise<void> => {
    const status   = String(req.query['status'] || 'submitted');
    const { page, per_page, offset } = getPaginationParams(req.query.page, req.query.per_page);

    const [countRes, dataRes] = await Promise.all([
      query<{count:string}>(`SELECT COUNT(*) as count FROM clinic_profiles WHERE verification_status = $1`, [status]),
      query(
        `SELECT id as clinic_profile_id, name, city, facility_type,
                license_number, license_document_url, verification_status,
                created_at as submitted_at
         FROM clinic_profiles WHERE verification_status = $1
         ORDER BY created_at ASC LIMIT $2 OFFSET $3`,
        [status, per_page, offset]
      ),
    ]);

    sendSuccess(res, { verifications: dataRes.rows }, 200,
      { page, per_page, total: parseInt(countRes.rows[0]?.count||'0',10) });
  }
);

router.post('/admin/verifications/clinics/:id/approve', ...adminAuth,
  async (req: Request, res: Response): Promise<void> => {
    const id = String(req.params['id']);
    await query(
      `UPDATE clinic_profiles
       SET verification_status = 'approved', verified_by = $2,
           verified_at = NOW(), is_visible = TRUE, updated_at = NOW()
       WHERE id = $1`,
      [id, req.user!.userId]
    );
    // Activate clinic admin users
    await query(
      `UPDATE users SET status = 'active', updated_at = NOW()
       WHERE id IN (SELECT user_id FROM clinic_admins WHERE clinic_id = $1)`,
      [id]
    );
    const clinic = await query<{name:string}>(`SELECT name FROM clinic_profiles WHERE id = $1`, [id]);
    sendSuccess(res, { clinic_profile_id: id, status: 'approved', clinic_name: clinic.rows[0]?.name });
  }
);

router.post('/admin/verifications/clinics/:id/reject', ...adminAuth,
  async (req: Request, res: Response): Promise<void> => {
    const id = String(req.params['id']);
    const { rejection_reason } = req.body as { rejection_reason: string };
    await query(
      `UPDATE clinic_profiles SET verification_status = 'rejected',
       rejection_reason = $2, updated_at = NOW() WHERE id = $1`,
      [id, rejection_reason]
    );
    sendSuccess(res, { clinic_profile_id: id, status: 'rejected' });
  }
);

// ── BOOKING FLAGS ─────────────────────────────────────────────

router.get('/admin/flags', ...adminAuth,
  async (req: Request, res: Response): Promise<void> => {
    const result = await query(
      `SELECT b.id as booking_id, b.booking_reference, b.flag_reason,
              b.flagged_at, b.flag_resolved_at,
              u_patient.full_name as patient_name,
              u_doc.full_name as doctor_name,
              cp.name as clinic_name,
              c.cancelled_by::text,
              c.minutes_before_appointment
       FROM bookings b
       JOIN patient_profiles pp ON pp.id = b.patient_id
       JOIN users u_patient      ON u_patient.id = pp.user_id
       JOIN doctor_profiles dp   ON dp.id = b.doctor_id
       JOIN users u_doc          ON u_doc.id = dp.user_id
       JOIN clinic_profiles cp   ON cp.id = b.clinic_id
       LEFT JOIN cancellations c ON c.booking_id = b.id
       WHERE b.is_flagged = TRUE AND b.flag_resolved_at IS NULL
       ORDER BY b.flagged_at DESC`
    );
    sendSuccess(res, { flags: result.rows });
  }
);

router.post('/admin/flags/:bookingId/resolve', ...adminAuth,
  async (req: Request, res: Response): Promise<void> => {
    const bookingId = String(req.params['bookingId']);
    const { resolution_note } = req.body as { resolution_note?: string };
    await query(
      `UPDATE bookings SET flag_resolved_at = NOW(), flag_resolved_by = $2,
       flag_reason = COALESCE($3, flag_reason), updated_at = NOW()
       WHERE id = $1`,
      [bookingId, req.user!.userId, resolution_note || null]
    );
    // Write audit log
    await query(
      `INSERT INTO booking_audit_log
         (booking_id, action, performed_by, performed_by_user_id, metadata)
       VALUES ($1, 'flag_resolved', 'platform_admin', $2, $3)`,
      [bookingId, req.user!.userId, JSON.stringify({ resolution_note })]
    );
    sendSuccess(res, { booking_id: bookingId, flag_resolved: true });
  }
);

// ── REVIEW MODERATION ─────────────────────────────────────────

router.get('/admin/reviews/pending', ...adminAuth,
  async (req: Request, res: Response): Promise<void> => {
    const { page, per_page, offset } = getPaginationParams(req.query.page, req.query.per_page);
    const result = await query(
      `SELECT r.id as review_id, r.rating, r.review_text, r.status,
              r.created_at, r.appointment_date,
              u_doc.full_name as doctor_name,
              cp.name as clinic_name
       FROM reviews r
       JOIN doctor_profiles dp ON dp.id = r.doctor_id
       JOIN users u_doc        ON u_doc.id = dp.user_id
       JOIN clinic_profiles cp ON cp.id = r.clinic_id
       WHERE r.status IN ('pending','flagged')
       ORDER BY r.created_at ASC
       LIMIT $1 OFFSET $2`,
      [per_page, offset]
    );
    sendSuccess(res, { reviews: result.rows }, 200, { page, per_page, total: result.rowCount || 0 });
  }
);

router.patch('/admin/reviews/:id', ...adminAuth,
  async (req: Request, res: Response): Promise<void> => {
    const id = String(req.params['id']);
    const { status, moderation_note } = req.body as { status: string; moderation_note?: string };
    await query(
      `UPDATE reviews SET status = $2, moderation_note = $3,
       moderated_by = $4, moderated_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [id, status, moderation_note || null, req.user!.userId]
    );
    sendSuccess(res, { review_id: id, status });
  }
);

// ── ANALYTICS ─────────────────────────────────────────────────

router.get('/admin/analytics/bookings', ...adminAuth,
  async (req: Request, res: Response): Promise<void> => {
    const fromDate = String(req.query['from_date'] || new Date(Date.now() - 30*86400000).toISOString().split('T')[0]);
    const toDate   = String(req.query['to_date']   || new Date().toISOString().split('T')[0]);

    const result = await query(
      `SELECT * FROM daily_booking_stats
       WHERE stat_date BETWEEN $1::date AND $2::date
       ORDER BY stat_date DESC`,
      [fromDate, toDate]
    );
    sendSuccess(res, { stats: result.rows, from_date: fromDate, to_date: toDate });
  }
);

export { router as adminRoutes };
