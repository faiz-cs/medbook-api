// src/modules/doctor/doctor.routes.ts
// ============================================================
//  Doctor Public Profile Routes
//  Used by patient app to view doctor profiles and reviews
// ============================================================

import { Router, Request, Response, RequestHandler } from 'express';
import { authenticate } from '../../middleware';
import { sendSuccess, Errors, getPaginationParams } from '../../utils/response';
import { query } from '../../config/database';
import { cacheGet, cacheSet, CacheKeys } from '../../config/redis';

const router = Router();

const qs = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : Array.isArray(v) ? String(v[0]) : undefined;

// ── GET /v1/doctors/:id — Full doctor profile ─────────────────
router.get('/doctors/:doctorId',
  async (req: Request, res: Response): Promise<void> => {
    const doctorId = String(req.params['doctorId']);

    // Try cache
    const cacheKey = CacheKeys.doctorProfile(doctorId);
    const cached = await cacheGet<Record<string, unknown>>(cacheKey);
    if (cached) { sendSuccess(res, cached); return; }

    // Doctor base info
    const doctorResult = await query(
      `SELECT
         dp.id as doctor_profile_id,
         u.id as user_id, u.full_name as doctor_name, u.avatar_url,
         dp.primary_specialty, dp.secondary_specialties,
         dp.qualifications, dp.years_of_experience, dp.languages_spoken,
         dp.consultation_fee_paise, dp.avg_rating, dp.total_reviews,
         dp.total_appointments, dp.bio, dp.achievements,
         dp.is_independent, dp.nmc_number
       FROM doctor_profiles dp
       JOIN users u ON u.id = dp.user_id
       WHERE dp.id = $1 AND dp.is_visible = TRUE AND u.deleted_at IS NULL`,
      [doctorId]
    );

    if (doctorResult.rowCount === 0) {
      Errors.notFound(res, 'Doctor not found.'); return;
    }

    const doctor = doctorResult.rows[0];

    // All active clinic locations with schedule info
    const locationsResult = await query(
      `SELECT
         cp.id as clinic_id, cp.name as clinic_name, cp.facility_type,
         cp.address_line1 || ', ' || COALESCE(cp.neighbourhood,'') || ', ' || cp.city as address,
         cp.neighbourhood, cp.city, cp.latitude, cp.longitude,
         sr.active_days as schedule_days,
         sr.start_time::text as schedule_start,
         sr.end_time::text as schedule_end,
         sr.slot_duration_minutes,
         (SELECT COUNT(*) FROM time_slots ts
          WHERE ts.doctor_id = dp.id AND ts.clinic_id = cp.id
            AND ts.slot_date = CURRENT_DATE AND ts.status = 'available'
         ) as available_slots_today,
         (SELECT ts.slot_date::text FROM time_slots ts
          WHERE ts.doctor_id = dp.id AND ts.clinic_id = cp.id
            AND ts.status = 'available' AND ts.slot_date >= CURRENT_DATE
          ORDER BY ts.slot_date LIMIT 1
         ) as next_available_date
       FROM schedule_rules sr
       JOIN clinic_profiles cp ON cp.id = sr.clinic_id
       JOIN doctor_profiles dp ON dp.id = sr.doctor_id
       WHERE sr.doctor_id = $1 AND sr.is_active = TRUE AND cp.is_visible = TRUE
       ORDER BY cp.name`,
      [doctorId]
    );

    // 3 most recent reviews preview
    const reviewsResult = await query(
      `SELECT r.rating, r.review_text, r.appointment_date,
              r.doctor_reply, r.created_at,
              CONCAT(LEFT(u.full_name,1),'*** ',SPLIT_PART(u.full_name,' ',2)) as patient_name_masked
       FROM reviews r
       JOIN patient_profiles pp ON pp.id = r.patient_id
       JOIN users u ON u.id = pp.user_id
       WHERE r.doctor_id = $1 AND r.status = 'published'
       ORDER BY r.created_at DESC
       LIMIT 3`,
      [doctorId]
    );

    const responseData = {
      doctor,
      locations:       locationsResult.rows,
      reviews_preview: reviewsResult.rows,
    };

    // Cache for 5 minutes
    await cacheSet(cacheKey, responseData, 300);

    sendSuccess(res, responseData);
  }
);

// ── GET /v1/doctors/:id/reviews — Paginated reviews ───────────
router.get('/doctors/:doctorId/reviews',
  async (req: Request, res: Response): Promise<void> => {
    const doctorId = String(req.params['doctorId']);
    const { page, per_page, offset } = getPaginationParams(req.query.page, req.query.per_page, 20);

    const [countRes, reviewsRes] = await Promise.all([
      query<{count:string; avg:string}>(
        `SELECT COUNT(*) as count, ROUND(AVG(rating)::numeric, 1)::text as avg
         FROM reviews WHERE doctor_id = $1 AND status = 'published'`,
        [doctorId]
      ),
      query(
        `SELECT r.id as review_id, r.rating, r.review_text,
                r.appointment_date, r.created_at, r.doctor_reply,
                cp.name as clinic_name,
                CONCAT(LEFT(u.full_name,1),'*** ',SPLIT_PART(u.full_name,' ',2)) as patient_name_masked
         FROM reviews r
         JOIN patient_profiles pp ON pp.id = r.patient_id
         JOIN users u              ON u.id = pp.user_id
         JOIN clinic_profiles cp   ON cp.id = r.clinic_id
         WHERE r.doctor_id = $1 AND r.status = 'published'
         ORDER BY r.created_at DESC
         LIMIT $2 OFFSET $3`,
        [doctorId, per_page, offset]
      ),
    ]);

    const total    = parseInt(countRes.rows[0]?.count || '0', 10);
    const avgRating = parseFloat(countRes.rows[0]?.avg || '0');

    sendSuccess(res, { reviews: reviewsRes.rows, avg_rating: avgRating }, 200, { page, per_page, total });
  }
);

// ── GET /v1/doctor/profile — Doctor views own profile ─────────
router.get('/doctor/profile',
  authenticate as RequestHandler,
  async (req: Request, res: Response): Promise<void> => {
    const result = await query(
      `SELECT dp.*, u.full_name, u.phone, u.email, u.avatar_url, u.preferred_language
       FROM doctor_profiles dp JOIN users u ON u.id = dp.user_id
       WHERE dp.user_id = $1`,
      [req.user!.userId]
    );
    if (result.rowCount === 0) { Errors.notFound(res, 'Doctor profile not found.'); return; }
    sendSuccess(res, { profile: result.rows[0] });
  }
);

// ── POST /v1/doctor/profile/reply-review ─────────────────────
router.post('/doctor/profile/reply-review',
  authenticate as RequestHandler,
  async (req: Request, res: Response): Promise<void> => {
    const { review_id, reply } = req.body as { review_id: string; reply: string };

    // Verify review belongs to this doctor
    const profile = await query<{id:string}>(
      `SELECT id FROM doctor_profiles WHERE user_id = $1`, [req.user!.userId]
    );
    if (!profile.rows[0]) { Errors.notFound(res, 'Doctor profile not found.'); return; }

    const result = await query(
      `UPDATE reviews SET doctor_reply = $1, doctor_replied_at = NOW(), updated_at = NOW()
       WHERE id = $2 AND doctor_id = $3 AND status = 'published' RETURNING id`,
      [reply, review_id, profile.rows[0].id]
    );

    if (result.rowCount === 0) { Errors.notFound(res, 'Review not found.'); return; }
    sendSuccess(res, { review_id, reply_saved: true });
  }
);

export { router as doctorRoutes };
