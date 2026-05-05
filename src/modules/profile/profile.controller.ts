// src/modules/profile/profile.controller.ts
// ============================================================
//  Profile Controller — HTTP handlers for all profile endpoints
// ============================================================

import { Request, Response } from 'express';
import {
  updateBasicProfile, getPatientProfile, upsertPatientProfile,
  getDoctorProfile, submitDoctorProfile, updateDoctorProfile,
  getClinicByAdminUserId, submitClinicProfile, updateClinicProfile,
} from './profile.service';
import { sendSuccess, Errors } from '../../utils/response';

// ── PATCH /v1/profile/basic ───────────────────────────────────
export async function updateBasicProfileHandler(req: Request, res: Response): Promise<void> {
  if (!req.user) { Errors.unauthorized(res); return; }

  const user = await updateBasicProfile(req.user.userId, req.body);
  sendSuccess(res, {
    user: {
      id:                 user.id,
      full_name:          user.full_name,
      city:               user.city,
      preferred_language: user.preferred_language,
      avatar_url:         user.avatar_url,
    },
  });
}

// ── POST /v1/profile/patient/setup ────────────────────────────
export async function setupPatientProfileHandler(req: Request, res: Response): Promise<void> {
  if (!req.user) { Errors.unauthorized(res); return; }

  const profile = await upsertPatientProfile(req.user.userId, req.body);
  sendSuccess(res, { profile });
}

// ── GET /v1/profile/patient ───────────────────────────────────
export async function getPatientProfileHandler(req: Request, res: Response): Promise<void> {
  if (!req.user) { Errors.unauthorized(res); return; }

  const profile = await getPatientProfile(req.user.userId);
  if (!profile) { Errors.notFound(res, 'Patient profile not found.'); return; }

  sendSuccess(res, { profile });
}

// ── POST /v1/profile/doctor/setup ────────────────────────────
export async function setupDoctorProfileHandler(req: Request, res: Response): Promise<void> {
  if (!req.user) { Errors.unauthorized(res); return; }

  try {
    const profile = await submitDoctorProfile(req.user.userId, req.body);
    sendSuccess(res, {
      profile,
      verification_status: 'submitted',
      message: 'Your profile is under review. We will notify you within 48 hours.',
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'NMC_DUPLICATE') {
      Errors.conflict(res, 'This NMC number is already registered. Contact support if this is an error.');
      return;
    }
    throw error;
  }
}

// ── PATCH /v1/profile/doctor ──────────────────────────────────
export async function updateDoctorProfileHandler(req: Request, res: Response): Promise<void> {
  if (!req.user) { Errors.unauthorized(res); return; }

  const profile = await getDoctorProfile(req.user.userId);
  if (!profile) { Errors.notFound(res, 'Doctor profile not found.'); return; }

  const updated = await updateDoctorProfile(req.user.userId, req.body);
  sendSuccess(res, { profile: updated });
}

// ── POST /v1/profile/clinic/setup ────────────────────────────
export async function setupClinicProfileHandler(req: Request, res: Response): Promise<void> {
  if (!req.user) { Errors.unauthorized(res); return; }

  const profile = await submitClinicProfile(req.user.userId, req.body);
  sendSuccess(res, {
    profile,
    verification_status: 'submitted',
    message: 'Your clinic profile is under review. We will notify you within 48 hours.',
  });
}

// ── PATCH /v1/profile/clinic ──────────────────────────────────
export async function updateClinicProfileHandler(req: Request, res: Response): Promise<void> {
  if (!req.user) { Errors.unauthorized(res); return; }

  const clinic = await getClinicByAdminUserId(req.user.userId);
  if (!clinic) { Errors.notFound(res, 'Clinic profile not found.'); return; }

  const updated = await updateClinicProfile(clinic.id, req.body);
  sendSuccess(res, { profile: updated });
}

// ── GET /v1/profile/clinic ────────────────────────────────────
export async function getClinicProfileHandler(req: Request, res: Response): Promise<void> {
  if (!req.user) { Errors.unauthorized(res); return; }

  const clinic = await getClinicByAdminUserId(req.user.userId);
  if (!clinic) { Errors.notFound(res, 'Clinic profile not found.'); return; }

  sendSuccess(res, { profile: clinic });
}
