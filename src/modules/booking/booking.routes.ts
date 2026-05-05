// src/modules/booking/booking.routes.ts
import { Router, Request, Response, RequestHandler } from 'express';
import { z } from 'zod';
import { authenticate, requireRole, validate } from '../../middleware';
import { sendSuccess, Errors, getPaginationParams } from '../../utils/response';
import { getDoctorProfile } from '../profile/profile.service';
import { BookingStatus } from '../../types';
import {
  initiateBooking, confirmBooking, getPatientBookings,
  getBookingDetail, cancelBooking, rescheduleBooking,
  submitReview, getDoctorAppointments, getDoctorDashboard,
} from './booking.service';

const router = Router();
const qs = (v: unknown): string | undefined => typeof v === 'string' ? v : Array.isArray(v) ? String(v[0]) : undefined;

// ── Schemas ───────────────────────────────────────────────────

const InitiateSchema = z.object({
  slot_id:          z.string().uuid(),
  reason_for_visit: z.string().max(500).optional(),
  payment_method:   z.enum(['pay_at_clinic','upi_online','card_online']).default('pay_at_clinic'),
});

const CancelSchema = z.object({
  reason: z.enum([
    'patient_personal','patient_recovered','patient_found_another_doctor','patient_cost_concern',
    'doctor_unavailable','doctor_emergency','doctor_schedule_change',
    'clinic_closed','clinic_emergency','clinic_doctor_left','other',
  ]),
  reason_detail: z.string().max(300).optional(),
});

const RescheduleSchema = z.object({
  new_slot_id: z.string().uuid(),
});

const ReviewSchema = z.object({
  rating:      z.number().int().min(1).max(5),
  review_text: z.string().max(1000).optional(),
  sub_ratings: z.record(z.string(), z.number().int().min(1).max(5)).optional(),
  submitted_via: z.enum(['in_app','whatsapp']).default('in_app'),
});

// ══════════════════════════════════════════════════════════════
//  PATIENT BOOKING FLOW
// ══════════════════════════════════════════════════════════════

// POST /v1/bookings/initiate
router.post('/bookings/initiate',
  authenticate as RequestHandler, requireRole('patient') as RequestHandler,
  validate(InitiateSchema) as RequestHandler,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const result = await initiateBooking({
        patientUserId:   req.user!.userId,
        slotId:          req.body.slot_id,
        sessionId:       req.user!.sessionId,
        reasonForVisit:  req.body.reason_for_visit,
        paymentMethod:   req.body.payment_method,
      });
      sendSuccess(res, result, 201);
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      if (err.message === 'SLOT_NOT_AVAILABLE') { Errors.slotUnavailable(res); return; }
      if (err.message === 'SLOT_NOT_FOUND')     { Errors.notFound(res, 'Slot not found.'); return; }
      if (err.message === 'PATIENT_NOT_FOUND')  { Errors.notFound(res, 'Patient profile not found. Please complete your profile.'); return; }
      throw err;
    }
  }
);

// POST /v1/bookings/:id/confirm
router.post('/bookings/:id/confirm',
  authenticate as RequestHandler, requireRole('patient') as RequestHandler,
  async (req: Request, res: Response): Promise<void> => {
    const bookingId = String(req.params['id']);
    try {
      const { bookingReference } = await confirmBooking(bookingId, req.user!.sessionId);
      sendSuccess(res, {
        booking_id:        bookingId,
        booking_reference: bookingReference,
        status:            'confirmed',
        whatsapp_sent:     true,
        sms_sent:          true,
      });
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      if (err.message.includes('lock expired') || err.message.includes('lock')) {
        Errors.slotLockExpired(res); return;
      }
      if (err.message.includes('not found') || err.message.includes('initiated')) {
        Errors.notFound(res, 'Booking not found or already confirmed.'); return;
      }
      throw err;
    }
  }
);

// GET /v1/bookings
router.get('/bookings',
  authenticate as RequestHandler, requireRole('patient') as RequestHandler,
  async (req: Request, res: Response): Promise<void> => {
    const { page, per_page } = getPaginationParams(req.query.page, req.query.per_page);
    const status = (qs(req.query.status) || 'all') as 'upcoming'|'completed'|'cancelled'|'all';
    const { bookings, total } = await getPatientBookings(req.user!.userId, status, page, per_page);
    sendSuccess(res, { bookings }, 200, { page, per_page, total });
  }
);

// GET /v1/bookings/:id
router.get('/bookings/:id',
  authenticate as RequestHandler,
  async (req: Request, res: Response): Promise<void> => {
    const booking = await getBookingDetail(String(req.params['id']), req.user!.userId);
    if (!booking) { Errors.notFound(res, 'Booking not found.'); return; }
    sendSuccess(res, { booking });
  }
);

// POST /v1/bookings/:id/cancel
router.post('/bookings/:id/cancel',
  authenticate as RequestHandler,
  validate(CancelSchema) as RequestHandler,
  async (req: Request, res: Response): Promise<void> => {
    const bookingId = String(req.params['id']);

    // Determine who is cancelling based on role
    const roleMap: Record<string, 'patient' | 'doctor' | 'clinic' | 'platform_admin'> = {
      patient:         'patient',
      doctor:          'doctor',
      clinic_admin:    'clinic',
      platform_admin:  'platform_admin',
    };
    const cancelledBy = roleMap[req.user!.role] || 'patient';

    try {
      const { cancellationId, isWithin2h } = await cancelBooking({
        bookingId,
        cancelledBy,
        userIdString:  req.user!.userId,
        reason:        req.body.reason,
        reasonDetail:  req.body.reason_detail,
      });
      sendSuccess(res, {
        cancellation_id:   cancellationId,
        booking_id:        bookingId,
        status:            'cancelled',
        slot_freed:        true,
        is_flagged:        isWithin2h,
      });
    } catch (err) {
      if (err instanceof Error && err.message.includes('cannot be cancelled')) {
        Errors.conflict(res, 'This booking cannot be cancelled.'); return;
      }
      throw err;
    }
  }
);

// POST /v1/bookings/:id/reschedule
router.post('/bookings/:id/reschedule',
  authenticate as RequestHandler,
  validate(RescheduleSchema) as RequestHandler,
  async (req: Request, res: Response): Promise<void> => {
    const oldBookingId = String(req.params['id']);
    const roleMap: Record<string, 'patient'|'doctor'|'clinic'> = {
      patient: 'patient', doctor: 'doctor', clinic_admin: 'clinic',
    };
    const rescheduledBy = roleMap[req.user!.role] || 'patient';

    try {
      const { newBookingId, newBookingReference } = await rescheduleBooking({
        oldBookingId,
        newSlotId:     req.body.new_slot_id,
        rescheduledBy,
        userIdString:  req.user!.userId,
        sessionId:     req.user!.sessionId,
      });
      sendSuccess(res, {
        old_booking_id:        oldBookingId,
        new_booking_id:        newBookingId,
        new_booking_reference: newBookingReference,
        whatsapp_sent:         true,
      });
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      if (err.message === 'SLOT_NOT_AVAILABLE') { Errors.slotUnavailable(res); return; }
      if (err.message.includes('different doctor')) { Errors.conflict(res, 'Cannot reschedule to a different doctor.'); return; }
      throw err;
    }
  }
);

// POST /v1/bookings/:id/review
router.post('/bookings/:id/review',
  authenticate as RequestHandler, requireRole('patient') as RequestHandler,
  validate(ReviewSchema) as RequestHandler,
  async (req: Request, res: Response): Promise<void> => {
    const bookingId = String(req.params['id']);
    try {
      const { reviewId } = await submitReview({
        bookingId,
        patientUserId: req.user!.userId,
        rating:        req.body.rating,
        reviewText:    req.body.review_text,
        subRatings:    req.body.sub_ratings,
        submittedVia:  req.body.submitted_via,
      });
      sendSuccess(res, {
        review_id: reviewId,
        status:    'published',
        message:   'Thank you for your review!',
      }, 201);
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      if (err.message.includes('not found') || err.message.includes('not completed')) {
        Errors.notFound(res, 'Booking not found or not yet completed.'); return;
      }
      if (err.message.includes('already exists')) {
        Errors.conflict(res, 'You have already reviewed this appointment.'); return;
      }
      if (err.message.includes('does not own')) {
        Errors.forbidden(res, 'This booking does not belong to you.'); return;
      }
      throw err;
    }
  }
);

// ══════════════════════════════════════════════════════════════
//  DOCTOR APPOINTMENT ROUTES
// ══════════════════════════════════════════════════════════════

// GET /v1/doctor/dashboard
router.get('/doctor/dashboard',
  authenticate as RequestHandler, requireRole('doctor') as RequestHandler,
  async (req: Request, res: Response): Promise<void> => {
    const profile = await getDoctorProfile(req.user!.userId);
    if (!profile) { Errors.notFound(res, 'Doctor profile not found.'); return; }
    const dashboard = await getDoctorDashboard(profile.id);
    sendSuccess(res, dashboard);
  }
);

// GET /v1/doctor/appointments
router.get('/doctor/appointments',
  authenticate as RequestHandler, requireRole('doctor') as RequestHandler,
  async (req: Request, res: Response): Promise<void> => {
    const profile = await getDoctorProfile(req.user!.userId);
    if (!profile) { Errors.notFound(res, 'Doctor profile not found.'); return; }

    const { page, per_page } = getPaginationParams(req.query.page, req.query.per_page);
    const date     = qs(req.query.date) || new Date().toISOString().split('T')[0];
    const clinicId = qs(req.query.clinic_id);
    const status   = qs(req.query.status) as BookingStatus | undefined;

    const { appointments, total } = await getDoctorAppointments(
      profile.id, date, clinicId, status, page, per_page
    );
    sendSuccess(res, { appointments }, 200, { page, per_page, total });
  }
);

export { router as bookingRoutes };
