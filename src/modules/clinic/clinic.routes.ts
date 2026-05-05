// src/modules/clinic/clinic.routes.ts
import { Router, Request, Response, RequestHandler } from 'express';
import { z } from 'zod';
import { authenticate, requireRole, validate } from '../../middleware';
import { sendSuccess, Errors } from '../../utils/response';
import { getClinicByAdminUserId } from '../profile/profile.service';
import {
  sendDoctorLinkRequest, inviteDoctorBySms, removeDoctorLink,
  getClinicDoctors, getClinicDashboardStats,
  getTodaysQueue, markBookingComplete,
} from './clinic.service';

const router = Router();

const LinkDoctorSchema = z.object({
  nmc_number:   z.string().min(5).max(50),
  request_note: z.string().max(300).optional(),
});

const InviteSchema = z.object({
  phone:       z.string().regex(/^\+91[6-9]\d{9}$/),
  doctor_name: z.string().max(100).optional(),
});

const qs = (val: unknown): string | undefined =>
  typeof val === 'string' ? val : Array.isArray(val) ? String(val[0]) : undefined;

// Helper — get clinic or 404
async function getClinic(req: Request, res: Response) {
  const clinic = await getClinicByAdminUserId(req.user!.userId);
  if (!clinic) { Errors.notFound(res, 'Clinic not found.'); return null; }
  return clinic;
}

// GET /v1/clinic/dashboard
router.get('/clinic/dashboard',
  authenticate as RequestHandler, requireRole('clinic_admin') as RequestHandler,
  async (req: Request, res: Response): Promise<void> => {
    const clinic = await getClinic(req, res); if (!clinic) return;
    const stats = await getClinicDashboardStats(clinic.id);
    sendSuccess(res, stats);
  }
);

// GET /v1/clinic/queue
router.get('/clinic/queue',
  authenticate as RequestHandler, requireRole('clinic_admin') as RequestHandler,
  async (req: Request, res: Response): Promise<void> => {
    const clinic = await getClinic(req, res); if (!clinic) return;
    const date     = qs(req.query.date);
    const doctorId = qs(req.query.doctor_id);
    const queue    = await getTodaysQueue(clinic.id, date, doctorId);
    sendSuccess(res, { queue });
  }
);

// PATCH /v1/clinic/queue/:bookingId/complete
router.patch('/clinic/queue/:bookingId/complete',
  authenticate as RequestHandler, requireRole('clinic_admin') as RequestHandler,
  async (req: Request, res: Response): Promise<void> => {
    const clinic = await getClinic(req, res); if (!clinic) return;
    const bookingId = String(req.params['bookingId']);
    try {
      await markBookingComplete(bookingId, clinic.id, req.user!.userId);
      sendSuccess(res, { booking_id: bookingId, status: 'completed' });
    } catch {
      Errors.notFound(res, 'Booking not found or already completed.');
    }
  }
);

// GET /v1/clinic/doctors
router.get('/clinic/doctors',
  authenticate as RequestHandler, requireRole('clinic_admin') as RequestHandler,
  async (req: Request, res: Response): Promise<void> => {
    const clinic = await getClinic(req, res); if (!clinic) return;
    const doctors = await getClinicDoctors(clinic.id);
    sendSuccess(res, { doctors });
  }
);

// POST /v1/clinic/doctors/link
router.post('/clinic/doctors/link',
  authenticate as RequestHandler, requireRole('clinic_admin') as RequestHandler,
  validate(LinkDoctorSchema) as RequestHandler,
  async (req: Request, res: Response): Promise<void> => {
    const clinic = await getClinic(req, res); if (!clinic) return;
    if (clinic.verification_status !== 'approved') {
      Errors.forbidden(res, 'Clinic must be verified before linking doctors.'); return;
    }
    try {
      const { linkId, doctorName } = await sendDoctorLinkRequest(
        clinic.id, req.user!.userId, req.body.nmc_number, req.body.request_note
      );
      sendSuccess(res, {
        link_id:     linkId,
        doctor_name: doctorName,
        status:      'pending',
        message:     `Link request sent to ${doctorName}. They will be notified.`,
      }, 201);
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      if (err.message === 'DOCTOR_NOT_FOUND')     { Errors.notFound(res, 'No verified doctor found with this NMC number.'); return; }
      if (err.message === 'ALREADY_LINKED')        { Errors.conflict(res, 'This doctor is already linked to your clinic.'); return; }
      if (err.message === 'LINK_ALREADY_PENDING')  { Errors.conflict(res, 'A link request is already pending for this doctor.'); return; }
      throw err;
    }
  }
);

// POST /v1/clinic/doctors/invite
router.post('/clinic/doctors/invite',
  authenticate as RequestHandler, requireRole('clinic_admin') as RequestHandler,
  validate(InviteSchema) as RequestHandler,
  async (req: Request, res: Response): Promise<void> => {
    const clinic = await getClinic(req, res); if (!clinic) return;
    await inviteDoctorBySms(clinic.id, req.body.phone, req.body.doctor_name);
    const masked = req.body.phone.slice(0, 6) + '****' + req.body.phone.slice(-2);
    sendSuccess(res, { invite_sent: true, phone_masked: masked });
  }
);

// DELETE /v1/clinic/doctors/:linkId
router.delete('/clinic/doctors/:linkId',
  authenticate as RequestHandler, requireRole('clinic_admin') as RequestHandler,
  async (req: Request, res: Response): Promise<void> => {
    const clinic = await getClinic(req, res); if (!clinic) return;
    const linkId = String(req.params['linkId']);
    try {
      const { affectedBookings } = await removeDoctorLink(linkId, clinic.id, req.user!.userId);
      sendSuccess(res, {
        link_id:            linkId,
        status:             'removed',
        affected_bookings:  affectedBookings,
        message: affectedBookings > 0
          ? `Doctor unlinked. ${affectedBookings} upcoming bookings will be notified.`
          : 'Doctor unlinked successfully.',
      });
    } catch {
      Errors.notFound(res, 'Link not found or already removed.');
    }
  }
);

export { router as clinicRoutes };
