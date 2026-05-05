// src/types/index.ts
// ============================================================
//  Shared TypeScript types used across the entire application
//  Mirrors our database enums and common data shapes
// ============================================================

import { Request } from 'express';

// ── Database Enums ────────────────────────────────────────────
export type UserRole = 'patient' | 'doctor' | 'clinic_admin' | 'platform_admin';

export type AccountStatus =
  | 'pending_verification'
  | 'active'
  | 'suspended'
  | 'deactivated';

export type AuthProvider = 'phone_otp' | 'google';

export type VerificationStatus =
  | 'not_submitted'
  | 'submitted'
  | 'under_review'
  | 'approved'
  | 'rejected'
  | 're_review';

export type FacilityType =
  | 'clinic'
  | 'hospital'
  | 'polyclinic'
  | 'diagnostic_center'
  | 'nursing_home';

export type LinkStatus = 'pending' | 'active' | 'rejected' | 'removed';

export type MedicalSpecialty =
  | 'general_physician'
  | 'cardiology'
  | 'dermatology'
  | 'orthopedics'
  | 'gynecology'
  | 'pediatrics'
  | 'ent'
  | 'neurology'
  | 'ophthalmology'
  | 'psychiatry'
  | 'urology'
  | 'nephrology'
  | 'gastroenterology'
  | 'pulmonology'
  | 'endocrinology'
  | 'oncology'
  | 'rheumatology'
  | 'dentistry'
  | 'physiotherapy'
  | 'general_surgery';

export type ScheduleRequestStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'counter_proposed'
  | 'expired'
  | 'cancelled';

export type SlotStatus = 'available' | 'booked' | 'blocked' | 'closed' | 'expired';

export type DayOfWeek =
  | 'monday'
  | 'tuesday'
  | 'wednesday'
  | 'thursday'
  | 'friday'
  | 'saturday'
  | 'sunday';

export type BookingStatus =
  | 'initiated'
  | 'confirmed'
  | 'completed'
  | 'cancelled'
  | 'rescheduled'
  | 'no_show';

export type PaymentMethod = 'pay_at_clinic' | 'upi_online' | 'card_online';

export type PaymentStatus =
  | 'not_applicable'
  | 'pending'
  | 'paid'
  | 'failed'
  | 'refunded';

export type ActionInitiator =
  | 'patient'
  | 'doctor'
  | 'clinic'
  | 'platform_admin'
  | 'system';

export type NotificationChannel = 'whatsapp' | 'sms' | 'push' | 'email';

export type NotificationDeliveryStatus =
  | 'queued'
  | 'sent'
  | 'delivered'
  | 'read'
  | 'failed'
  | 'bounced';

// ── Database Row Types ────────────────────────────────────────
// These mirror database table columns exactly

export interface UserRow {
  id:                 string;
  phone:              string;
  email:              string | null;
  role:               UserRole;
  status:             AccountStatus;
  auth_provider:      AuthProvider;
  google_id:          string | null;
  full_name:          string;
  preferred_language: string;
  city:               string | null;
  avatar_url:         string | null;
  consent_given_at:   Date | null;
  consent_version:    string | null;
  fcm_token:          string | null;
  deleted_at:         Date | null;
  created_at:         Date;
  updated_at:         Date;
}

export interface PatientProfileRow {
  id:                       string;
  user_id:                  string;
  date_of_birth:            Date | null;
  gender:                   string | null;
  blood_group:              string | null;
  emergency_contact_name:   string | null;
  emergency_contact_phone:  string | null;
  health_notes:             Record<string, unknown>;
  total_bookings:           number;
  created_at:               Date;
  updated_at:               Date;
}

export interface DoctorProfileRow {
  id:                     string;
  user_id:                string;
  nmc_number:             string | null;
  primary_specialty:      MedicalSpecialty;
  secondary_specialties:  MedicalSpecialty[];
  qualifications:         Qualification[];
  years_of_experience:    number;
  languages_spoken:       string[];
  consultation_fee_paise: number;
  bio:                    string | null;
  achievements:           Record<string, unknown>;
  is_independent:         boolean;
  verification_status:    VerificationStatus;
  verified_by:            string | null;
  verified_at:            Date | null;
  rejection_reason:       string | null;
  nmc_document_url:       string | null;
  avg_rating:             number;
  total_reviews:          number;
  total_appointments:     number;
  is_visible:             boolean;
  created_at:             Date;
  updated_at:             Date;
}

export interface ClinicProfileRow {
  id:                   string;
  name:                 string;
  facility_type:        FacilityType;
  address_line1:        string;
  address_line2:        string | null;
  neighbourhood:        string | null;
  city:                 string;
  state:                string;
  pincode:              string;
  latitude:             number | null;
  longitude:            number | null;
  phone:                string;
  alternate_phone:      string | null;
  email:                string | null;
  website_url:          string | null;
  operating_hours:      Record<string, OperatingHours>;
  departments:          MedicalSpecialty[];
  photo_urls:           string[];
  license_number:       string | null;
  license_document_url: string | null;
  verification_status:  VerificationStatus;
  verified_by:          string | null;
  verified_at:          Date | null;
  rejection_reason:     string | null;
  avg_rating:           number;
  total_reviews:        number;
  is_visible:           boolean;
  deleted_at:           Date | null;
  created_at:           Date;
  updated_at:           Date;
}

export interface BookingRow {
  id:                   string;
  booking_reference:    string;
  patient_id:           string;
  doctor_id:            string;
  clinic_id:            string;
  slot_id:              string;
  appointment_date:     Date;
  appointment_start_at: Date;
  appointment_end_at:   Date;
  status:               BookingStatus;
  reason_for_visit:     string | null;
  payment_method:       PaymentMethod;
  payment_status:       PaymentStatus;
  fee_paise:            number;
  payment_gateway_ref:  string | null;
  payment_confirmed_at: Date | null;
  completed_at:         Date | null;
  completed_by:         string | null;
  is_flagged:           boolean;
  flag_reason:          string | null;
  flagged_at:           Date | null;
  created_at:           Date;
  updated_at:           Date;
}

// ── Nested Types ──────────────────────────────────────────────

export interface Qualification {
  degree:  string;
  college: string;
  year:    number;
}

export interface OperatingHours {
  open?:   string;  // "08:00"
  close?:  string;  // "20:00"
  closed?: boolean;
}

// ── JWT Payload ───────────────────────────────────────────────

export interface JwtAccessPayload {
  userId:     string;
  role:       UserRole;
  sessionId:  string;
  type:       'access';
  iat?:       number;
  exp?:       number;
}

export interface JwtRefreshPayload {
  userId:    string;
  sessionId: string;
  type:      'refresh';
  iat?:      number;
  exp?:      number;
}

// ── Augmented Express Request ─────────────────────────────────
// After auth middleware runs, req.user is populated
declare global {
  namespace Express {
    interface Request {
      user?: {
        userId:    string;
        role:      UserRole;
        sessionId: string;
      };
    }
  }
}

// ── API Response Types ────────────────────────────────────────

export interface ApiResponse<T = unknown> {
  success: boolean;
  data:    T | null;
  error:   ApiError | null;
  meta?:   PaginationMeta;
}

export interface ApiError {
  code:     string;
  message:  string;
  details?: Record<string, unknown>;
}

export interface PaginationMeta {
  page:     number;
  per_page: number;
  total:    number;
}

export interface PaginationParams {
  page:     number;
  per_page: number;
  offset:   number;
}
