// src/modules/profile/profile.routes.ts
// ============================================================
//  Profile Routes — all profile setup and update endpoints
// ============================================================

import { Router } from 'express';
import { z } from 'zod';
import {
  updateBasicProfileHandler,
  setupPatientProfileHandler, getPatientProfileHandler,
  setupDoctorProfileHandler,  updateDoctorProfileHandler,
  setupClinicProfileHandler,  updateClinicProfileHandler,
  getClinicProfileHandler,
} from './profile.controller';
import { authenticate, requireRole, validate } from '../../middleware';

const router = Router();

// ── Validation Schemas ────────────────────────────────────────

const BasicProfileSchema = z.object({
  full_name:          z.string().min(2).max(100).optional(),
  city:               z.string().max(100).optional(),
  preferred_language: z.enum(['en','hi','kn','ta','te','mr']).optional(),
  avatar_url:         z.string().url().optional(),
}).strict();

const PatientSetupSchema = z.object({
  date_of_birth:            z.string().regex(/^d{4}-d{2}-d{2}$/).optional(),
  gender:                   z.enum(['male','female','other','prefer_not_to_say']).optional(),
  blood_group:              z.enum(['A+','A-','B+','B-','O+','O-','AB+','AB-']).optional(),
  emergency_contact_name:   z.string().max(100).optional(),
  emergency_contact_phone:  z.string().regex(/^\+91[6-9]\d{9}$/).optional(),
}).strict();

const QualificationSchema = z.object({
  degree:  z.string().min(2).max(20),
  college: z.string().min(2).max(200),
  year:    z.number().int().min(1950).max(new Date().getFullYear()),
});

const SPECIALTIES = [
  'general_physician','cardiology','dermatology','orthopedics',
  'gynecology','pediatrics','ent','neurology','ophthalmology',
  'psychiatry','urology','nephrology','gastroenterology',
  'pulmonology','endocrinology','oncology','rheumatology',
  'dentistry','physiotherapy','general_surgery',
] as const;

const DoctorSetupSchema = z.object({
  nmc_number:             z.string().min(5).max(50),
  primary_specialty:      z.enum(SPECIALTIES),
  secondary_specialties:  z.array(z.enum(SPECIALTIES)).max(5).optional(),
  qualifications:         z.array(QualificationSchema).min(1).max(10),
  years_of_experience:    z.number().int().min(0).max(60),
  languages_spoken:       z.array(z.enum(['en','hi','kn','ta','te','mr','bn','gu'])).min(1),
  consultation_fee_paise: z.number().int().min(0).max(100000000),
  bio:                    z.string().max(500).optional(),
  achievements:           z.record(z.string(), z.unknown()).optional(),
  is_independent:         z.boolean(),
  nmc_document_url:       z.string().url().optional(),
});

const DoctorUpdateSchema = z.object({
  bio:                    z.string().max(500).optional(),
  consultation_fee_paise: z.number().int().min(0).optional(),
  languages_spoken:       z.array(z.string()).optional(),
  achievements:           z.record(z.string(), z.unknown()).optional(),
}).strict();

const OperatingHoursSchema = z.record(z.string(),
  z.object({
    open:   z.string().regex(/^\d{2}:\d{2}$/).optional(),
    close:  z.string().regex(/^\d{2}:\d{2}$/).optional(),
    closed: z.boolean().optional(),
  })
);

const ClinicSetupSchema = z.object({
  name:             z.string().min(3).max(255),
  facility_type:    z.enum(['clinic','hospital','polyclinic','diagnostic_center','nursing_home']),
  address_line1:    z.string().min(5).max(255),
  address_line2:    z.string().max(255).optional(),
  neighbourhood:    z.string().max(100).optional(),
  city:             z.string().min(2).max(100),
  state:            z.string().min(2).max(100),
  pincode:          z.string().regex(/^\d{6}$/, 'Pincode must be 6 digits'),
  latitude:         z.number().min(-90).max(90).optional(),
  longitude:        z.number().min(-180).max(180).optional(),
  phone:            z.string().regex(/^\+91[6-9]\d{9}$/),
  alternate_phone:  z.string().regex(/^\+91[6-9]\d{9}$/).optional(),
  email:            z.string().email().optional(),
  website_url:      z.string().url().optional(),
  operating_hours:  OperatingHoursSchema,
  departments:      z.array(z.enum(SPECIALTIES)).optional(),
  license_number:   z.string().max(100).optional(),
  license_document_url: z.string().url().optional(),
});

const ClinicUpdateSchema = z.object({
  operating_hours: OperatingHoursSchema.optional(),
  departments:     z.array(z.enum(SPECIALTIES)).optional(),
  photo_urls:      z.array(z.string().url()).max(10).optional(),
  alternate_phone: z.string().regex(/^\+91[6-9]\d{9}$/).optional(),
  email:           z.string().email().optional(),
  website_url:     z.string().url().optional(),
}).strict();

// ── Routes ────────────────────────────────────────────────────

// Basic profile — all roles
router.patch('/basic',
  authenticate,
  validate(BasicProfileSchema),
  updateBasicProfileHandler
);

// Patient routes
router.post('/patient/setup',
  authenticate,
  requireRole('patient'),
  validate(PatientSetupSchema),
  setupPatientProfileHandler
);
router.get('/patient',
  authenticate,
  requireRole('patient'),
  getPatientProfileHandler
);

// Doctor routes
router.post('/doctor/setup',
  authenticate,
  requireRole('doctor'),
  validate(DoctorSetupSchema),
  setupDoctorProfileHandler
);
router.patch('/doctor',
  authenticate,
  requireRole('doctor'),
  validate(DoctorUpdateSchema),
  updateDoctorProfileHandler
);

// Clinic routes
router.post('/clinic/setup',
  authenticate,
  requireRole('clinic_admin'),
  validate(ClinicSetupSchema),
  setupClinicProfileHandler
);
router.patch('/clinic',
  authenticate,
  requireRole('clinic_admin'),
  validate(ClinicUpdateSchema),
  updateClinicProfileHandler
);
router.get('/clinic',
  authenticate,
  requireRole('clinic_admin'),
  getClinicProfileHandler
);

export { router as profileRoutes };
