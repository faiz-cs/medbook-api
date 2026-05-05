// src/modules/scheduling/scheduling.routes.ts
import { Router, Request, Response, RequestHandler } from 'express';
import { z } from 'zod';
import { authenticate, requireRole, validate } from '../../middleware';
import { sendSuccess, Errors } from '../../utils/response';
import {
  createScheduleRequest, getDoctorScheduleRequests,
  markRequestViewed, approveScheduleRequest, rejectScheduleRequest,
  counterProposeSchedule, getDoctorSchedule, blockDates,
  getClinicScheduleRequests, getDoctorLinkedClinics, getAvailableSlots,
} from './scheduling.service';
import { getDoctorProfile, getClinicByAdminUserId } from '../profile/profile.service';

type ScheduleRequestStatus = 'pending'|'approved'|'rejected'|'counter_proposed'|'expired'|'cancelled'|'all';
const qs = (val: unknown): string|undefined => typeof val==='string' ? val : Array.isArray(val) ? String(val[0]) : undefined;

const router = Router();

const DAYS = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'] as const;

const ScheduleRequestSchema = z.object({
  doctor_id: z.string().uuid(),
  proposed_days: z.array(z.enum(DAYS)).min(1),
  proposed_start_time: z.string().regex(/^\d{2}:\d{2}$/),
  proposed_end_time: z.string().regex(/^\d{2}:\d{2}$/),
  slot_duration_minutes: z.number().int().refine(v => [10,15,20,30,45,60].includes(v)),
  max_patients_per_day: z.number().int().min(1).max(100),
  effective_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  effective_until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  clinic_note: z.string().max(500).optional(),
});

const RejectSchema = z.object({ rejection_note: z.string().max(500).optional() });

const CounterProposeSchema = z.object({
  proposed_days: z.array(z.enum(DAYS)).min(1),
  proposed_start_time: z.string().regex(/^\d{2}:\d{2}$/),
  proposed_end_time: z.string().regex(/^\d{2}:\d{2}$/),
  note: z.string().max(500).optional(),
});

const BlockDatesSchema = z.object({
  block_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  block_until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reason: z.enum(['vacation','conference','personal','medical_leave','public_holiday','clinic_closure','other']),
  note: z.string().max(300).optional(),
  clinic_id: z.string().uuid().optional(),
});

const SlotQuerySchema = z.object({
  clinic_id: z.string().uuid(),
  from_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

// ── DOCTOR ROUTES ────────────────────────────────────────────

router.get('/doctor/schedule-requests', authenticate as RequestHandler, requireRole('doctor') as RequestHandler,
  async (req: Request, res: Response): Promise<void> => {
    const profile = await getDoctorProfile(req.user!.userId);
    if (!profile) { Errors.notFound(res, 'Doctor profile not found.'); return; }
    const status = (qs(req.query.status) || 'pending') as ScheduleRequestStatus;
    sendSuccess(res, { requests: await getDoctorScheduleRequests(profile.id, status) });
  }
);

router.post('/doctor/schedule-requests/:id/approve', authenticate as RequestHandler, requireRole('doctor') as RequestHandler,
  async (req: Request, res: Response): Promise<void> => {
    const profile = await getDoctorProfile(req.user!.userId);
    if (!profile) { Errors.notFound(res, 'Doctor profile not found.'); return; }
    const id = String(req.params['id']);
    await markRequestViewed(id);
    try {
      const { ruleId, slotsGenerated } = await approveScheduleRequest(id, req.user!.userId, profile.id);
      sendSuccess(res, { request_id: id, status: 'approved', schedule_rule_id: ruleId, slots_generated: slotsGenerated, message: 'Schedule approved. Slots are now live on your profile.' });
    } catch (err) {
      if (err instanceof Error && err.message === 'REQUEST_NOT_FOUND') { Errors.notFound(res, 'Request not found.'); return; }
      throw err;
    }
  }
);

router.post('/doctor/schedule-requests/:id/reject', authenticate as RequestHandler, requireRole('doctor') as RequestHandler, validate(RejectSchema) as RequestHandler,
  async (req: Request, res: Response): Promise<void> => {
    const profile = await getDoctorProfile(req.user!.userId);
    if (!profile) { Errors.notFound(res, 'Doctor profile not found.'); return; }
    const id = String(req.params['id']);
    await markRequestViewed(id);
    try {
      await rejectScheduleRequest(id, profile.id, req.body.rejection_note);
      sendSuccess(res, { request_id: id, status: 'rejected' });
    } catch { Errors.notFound(res, 'Request not found.'); }
  }
);

router.post('/doctor/schedule-requests/:id/counter-propose', authenticate as RequestHandler, requireRole('doctor') as RequestHandler, validate(CounterProposeSchema) as RequestHandler,
  async (req: Request, res: Response): Promise<void> => {
    const profile = await getDoctorProfile(req.user!.userId);
    if (!profile) { Errors.notFound(res, 'Doctor profile not found.'); return; }
    const id = String(req.params['id']);
    try {
      await counterProposeSchedule(id, profile.id, req.body);
      sendSuccess(res, { request_id: id, status: 'counter_proposed' });
    } catch { Errors.notFound(res, 'Request not found.'); }
  }
);

router.get('/doctor/schedule', authenticate as RequestHandler, requireRole('doctor') as RequestHandler,
  async (req: Request, res: Response): Promise<void> => {
    const profile = await getDoctorProfile(req.user!.userId);
    if (!profile) { Errors.notFound(res, 'Doctor profile not found.'); return; }
    const [active, pending] = await Promise.all([getDoctorSchedule(profile.id), getDoctorScheduleRequests(profile.id, 'pending')]);
    sendSuccess(res, { active_schedules: active, pending_requests: pending.length });
  }
);

router.post('/doctor/blocked-dates', authenticate as RequestHandler, requireRole('doctor') as RequestHandler, validate(BlockDatesSchema) as RequestHandler,
  async (req: Request, res: Response): Promise<void> => {
    const profile = await getDoctorProfile(req.user!.userId);
    if (!profile) { Errors.notFound(res, 'Doctor profile not found.'); return; }
    const result = await blockDates(profile.id, req.user!.userId, req.body);
    sendSuccess(res, { blocked_date_id: result.blockedDateId, affected_slots: result.affectedSlots, affected_bookings: result.affectedBookings, message: result.affectedBookings > 0 ? `${result.affectedBookings} patients will be notified.` : 'Dates blocked.' });
  }
);

router.get('/doctor/clinics', authenticate as RequestHandler, requireRole('doctor') as RequestHandler,
  async (req: Request, res: Response): Promise<void> => {
    const profile = await getDoctorProfile(req.user!.userId);
    if (!profile) { Errors.notFound(res, 'Doctor profile not found.'); return; }
    sendSuccess(res, { clinics: await getDoctorLinkedClinics(profile.id) });
  }
);

// ── CLINIC ROUTES ────────────────────────────────────────────

router.post('/clinic/schedule-requests', authenticate as RequestHandler, requireRole('clinic_admin') as RequestHandler, validate(ScheduleRequestSchema) as RequestHandler,
  async (req: Request, res: Response): Promise<void> => {
    const clinic = await getClinicByAdminUserId(req.user!.userId);
    if (!clinic) { Errors.notFound(res, 'Clinic not found.'); return; }
    if (clinic.verification_status !== 'approved') { Errors.forbidden(res, 'Clinic must be verified first.'); return; }
    try {
      const request = await createScheduleRequest({ doctorId: req.body.doctor_id, clinicId: clinic.id, requestedByUserId: req.user!.userId, proposedDays: req.body.proposed_days, proposedStartTime: req.body.proposed_start_time, proposedEndTime: req.body.proposed_end_time, slotDurationMinutes: req.body.slot_duration_minutes, maxPatientsPerDay: req.body.max_patients_per_day, effectiveFrom: req.body.effective_from, effectiveUntil: req.body.effective_until, clinicNote: req.body.clinic_note });
      sendSuccess(res, { request_id: request.id, status: 'pending', message: 'Request sent. Doctor has 48 hours to respond.' }, 201);
    } catch (err) {
      if (err instanceof Error && err.message === 'LINK_NOT_ACTIVE') { Errors.conflict(res, 'Doctor is not linked to your clinic.'); return; }
      throw err;
    }
  }
);

router.get('/clinic/schedule-requests', authenticate as RequestHandler, requireRole('clinic_admin') as RequestHandler,
  async (req: Request, res: Response): Promise<void> => {
    const clinic = await getClinicByAdminUserId(req.user!.userId);
    if (!clinic) { Errors.notFound(res, 'Clinic not found.'); return; }
    sendSuccess(res, { requests: await getClinicScheduleRequests(clinic.id) });
  }
);

// ── PUBLIC ───────────────────────────────────────────────────

router.get('/doctors/:doctorId/slots', validate(SlotQuerySchema, 'query') as RequestHandler,
  async (req: Request, res: Response): Promise<void> => {
    const doctorId = String(req.params['doctorId']);
    const today  = new Date().toISOString().split('T')[0];
    const inWeek = new Date(Date.now()+7*86400000).toISOString().split('T')[0];
    const slots  = await getAvailableSlots(doctorId, qs(req.query.clinic_id)||'', qs(req.query.from_date)||today, qs(req.query.to_date)||inWeek);
    sendSuccess(res, { slots_by_date: slots });
  }
);

export { router as schedulingRoutes };
