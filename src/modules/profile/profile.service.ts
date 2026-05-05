// src/modules/profile/profile.service.ts
// ============================================================
//  Profile Service
//  Handles profile setup and updates for all three roles:
//  patient, doctor, and clinic_admin
// ============================================================

import { query, transaction } from '../../config/database';
import { cacheDel, CacheKeys } from '../../config/redis';
import { logger } from '../../config/logger';
import {
  UserRow, PatientProfileRow, DoctorProfileRow,
  ClinicProfileRow, MedicalSpecialty, FacilityType,
  Qualification, OperatingHours,
} from '../../types';

// ── PATIENT PROFILE ───────────────────────────────────────────

export async function getPatientProfile(
  userId: string
): Promise<PatientProfileRow | null> {
  const result = await query<PatientProfileRow>(
    `SELECT pp.* FROM patient_profiles pp
     JOIN users u ON u.id = pp.user_id
     WHERE pp.user_id = $1`,
    [userId]
  );
  return result.rows[0] || null;
}

export async function upsertPatientProfile(
  userId: string,
  data: {
    date_of_birth?:           string;
    gender?:                  string;
    blood_group?:             string;
    emergency_contact_name?:  string;
    emergency_contact_phone?: string;
  }
): Promise<PatientProfileRow> {
  // Upsert: insert if not exists, update if exists
  const result = await query<PatientProfileRow>(
    `INSERT INTO patient_profiles
       (user_id, date_of_birth, gender, blood_group,
        emergency_contact_name, emergency_contact_phone)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id) DO UPDATE SET
       date_of_birth             = COALESCE(EXCLUDED.date_of_birth, patient_profiles.date_of_birth),
       gender                    = COALESCE(EXCLUDED.gender, patient_profiles.gender),
       blood_group               = COALESCE(EXCLUDED.blood_group, patient_profiles.blood_group),
       emergency_contact_name    = COALESCE(EXCLUDED.emergency_contact_name, patient_profiles.emergency_contact_name),
       emergency_contact_phone   = COALESCE(EXCLUDED.emergency_contact_phone, patient_profiles.emergency_contact_phone),
       updated_at                = NOW()
     RETURNING *`,
    [
      userId,
      data.date_of_birth || null,
      data.gender        || null,
      data.blood_group   || null,
      data.emergency_contact_name  || null,
      data.emergency_contact_phone || null,
    ]
  );
  return result.rows[0];
}

export async function updateBasicProfile(
  userId: string,
  data: {
    full_name?:          string;
    city?:               string;
    preferred_language?: string;
    avatar_url?:         string;
  }
): Promise<UserRow> {
  // Build dynamic SET clause (only update provided fields)
  const updates: string[] = [];
  const values:  unknown[] = [];
  let   idx = 1;

  if (data.full_name)          { updates.push(`full_name = $${idx++}`);          values.push(data.full_name); }
  if (data.city)               { updates.push(`city = $${idx++}`);               values.push(data.city); }
  if (data.preferred_language) { updates.push(`preferred_language = $${idx++}`); values.push(data.preferred_language); }
  if (data.avatar_url)         { updates.push(`avatar_url = $${idx++}`);         values.push(data.avatar_url); }

  if (updates.length === 0) {
    // Nothing to update — just return current user
    const r = await query<UserRow>(`SELECT * FROM users WHERE id = $1`, [userId]);
    return r.rows[0];
  }

  updates.push(`updated_at = NOW()`);
  values.push(userId);

  const result = await query<UserRow>(
    `UPDATE users SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  );
  return result.rows[0];
}

// ── DOCTOR PROFILE ────────────────────────────────────────────

export async function getDoctorProfile(
  userId: string
): Promise<DoctorProfileRow | null> {
  const result = await query<DoctorProfileRow>(
    `SELECT * FROM doctor_profiles WHERE user_id = $1`,
    [userId]
  );
  return result.rows[0] || null;
}

export async function getDoctorProfileById(
  doctorProfileId: string
): Promise<DoctorProfileRow | null> {
  const result = await query<DoctorProfileRow>(
    `SELECT * FROM doctor_profiles WHERE id = $1`,
    [doctorProfileId]
  );
  return result.rows[0] || null;
}

export async function submitDoctorProfile(
  userId: string,
  data: {
    nmc_number:               string;
    primary_specialty:        MedicalSpecialty;
    secondary_specialties?:   MedicalSpecialty[];
    qualifications:           Qualification[];
    years_of_experience:      number;
    languages_spoken:         string[];
    consultation_fee_paise:   number;
    bio?:                     string;
    achievements?:            Record<string, unknown>;
    is_independent:           boolean;
    nmc_document_url?:        string;
  }
): Promise<DoctorProfileRow> {
  // Check NMC number not already taken
  const existing = await query(
    `SELECT id FROM doctor_profiles WHERE nmc_number = $1 AND user_id != $2`,
    [data.nmc_number, userId]
  );
  if (existing.rowCount && existing.rowCount > 0) {
    throw new Error('NMC_DUPLICATE');
  }

  const result = await query<DoctorProfileRow>(
    `INSERT INTO doctor_profiles
       (user_id, nmc_number, primary_specialty, secondary_specialties,
        qualifications, years_of_experience, languages_spoken,
        consultation_fee_paise, bio, achievements, is_independent,
        nmc_document_url, verification_status, is_visible)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'submitted', FALSE)
     ON CONFLICT (user_id) DO UPDATE SET
       nmc_number              = EXCLUDED.nmc_number,
       primary_specialty       = EXCLUDED.primary_specialty,
       secondary_specialties   = EXCLUDED.secondary_specialties,
       qualifications          = EXCLUDED.qualifications,
       years_of_experience     = EXCLUDED.years_of_experience,
       languages_spoken        = EXCLUDED.languages_spoken,
       consultation_fee_paise  = EXCLUDED.consultation_fee_paise,
       bio                     = EXCLUDED.bio,
       achievements            = EXCLUDED.achievements,
       is_independent          = EXCLUDED.is_independent,
       nmc_document_url        = EXCLUDED.nmc_document_url,
       verification_status     = 'submitted',
       updated_at              = NOW()
     RETURNING *`,
    [
      userId,
      data.nmc_number,
      data.primary_specialty,
      data.secondary_specialties || [],
      JSON.stringify(data.qualifications),
      data.years_of_experience,
      data.languages_spoken,
      data.consultation_fee_paise,
      data.bio || null,
      JSON.stringify(data.achievements || {}),
      data.is_independent,
      data.nmc_document_url || null,
    ]
  );

  // Update user status to pending_verification
  await query(
    `UPDATE users SET status = 'pending_verification', updated_at = NOW() WHERE id = $1`,
    [userId]
  );

  logger.info('Doctor profile submitted for verification', {
    userId,
    nmcNumber: data.nmc_number,
  });

  return result.rows[0];
}

export async function updateDoctorProfile(
  userId: string,
  data: {
    bio?:                   string;
    consultation_fee_paise?: number;
    languages_spoken?:      string[];
    achievements?:          Record<string, unknown>;
    avatar_url?:            string;
  }
): Promise<DoctorProfileRow> {
  const updates: string[] = [];
  const values:  unknown[] = [];
  let   idx = 1;

  if (data.bio !== undefined)                  { updates.push(`bio = $${idx++}`);                     values.push(data.bio); }
  if (data.consultation_fee_paise !== undefined){ updates.push(`consultation_fee_paise = $${idx++}`);  values.push(data.consultation_fee_paise); }
  if (data.languages_spoken)                   { updates.push(`languages_spoken = $${idx++}`);        values.push(data.languages_spoken); }
  if (data.achievements)                       { updates.push(`achievements = $${idx++}`);            values.push(JSON.stringify(data.achievements)); }

  updates.push(`updated_at = NOW()`);
  values.push(userId);

  const result = await query<DoctorProfileRow>(
    `UPDATE doctor_profiles SET ${updates.join(', ')}
     WHERE user_id = $${idx} RETURNING *`,
    values
  );

  // Invalidate doctor profile cache
  if (result.rows[0]) {
    await cacheDel(CacheKeys.doctorProfile(result.rows[0].id));
  }

  return result.rows[0];
}

// ── CLINIC PROFILE ────────────────────────────────────────────

export async function getClinicByAdminUserId(
  userId: string
): Promise<ClinicProfileRow | null> {
  const result = await query<ClinicProfileRow>(
    `SELECT cp.*
     FROM clinic_profiles cp
     JOIN clinic_admins ca ON ca.clinic_id = cp.id
     WHERE ca.user_id = $1 AND ca.is_active = TRUE
     LIMIT 1`,
    [userId]
  );
  return result.rows[0] || null;
}

export async function getClinicById(
  clinicId: string
): Promise<ClinicProfileRow | null> {
  const result = await query<ClinicProfileRow>(
    `SELECT * FROM clinic_profiles WHERE id = $1 AND deleted_at IS NULL`,
    [clinicId]
  );
  return result.rows[0] || null;
}

export async function submitClinicProfile(
  userId: string,
  data: {
    name:             string;
    facility_type:    FacilityType;
    address_line1:    string;
    address_line2?:   string;
    neighbourhood?:   string;
    city:             string;
    state:            string;
    pincode:          string;
    latitude?:        number;
    longitude?:       number;
    phone:            string;
    alternate_phone?: string;
    email?:           string;
    website_url?:     string;
    operating_hours:  Record<string, OperatingHours>;
    departments?:     MedicalSpecialty[];
    license_number?:  string;
    license_document_url?: string;
  }
): Promise<ClinicProfileRow> {
  return transaction(async (client) => {
    // Create clinic profile
    const clinicResult = await client.query<ClinicProfileRow>(
      `INSERT INTO clinic_profiles
         (name, facility_type, address_line1, address_line2, neighbourhood,
          city, state, pincode, latitude, longitude, phone, alternate_phone,
          email, website_url, operating_hours, departments, license_number,
          license_document_url, verification_status, is_visible)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'submitted',FALSE)
       RETURNING *`,
      [
        data.name,
        data.facility_type,
        data.address_line1,
        data.address_line2    || null,
        data.neighbourhood    || null,
        data.city,
        data.state,
        data.pincode,
        data.latitude         || null,
        data.longitude        || null,
        data.phone,
        data.alternate_phone  || null,
        data.email            || null,
        data.website_url      || null,
        JSON.stringify(data.operating_hours),
        data.departments      || [],
        data.license_number   || null,
        data.license_document_url || null,
      ]
    );
    const clinic = clinicResult.rows[0];

    // Add the submitting user as clinic owner
    await client.query(
      `INSERT INTO clinic_admins (clinic_id, user_id, admin_role, accepted_at)
       VALUES ($1, $2, 'owner', NOW())`,
      [clinic.id, userId]
    );

    // Update user status to pending_verification
    await client.query(
      `UPDATE users SET status = 'pending_verification', updated_at = NOW() WHERE id = $1`,
      [userId]
    );

    logger.info('Clinic profile submitted for verification', {
      userId,
      clinicName: data.name,
      city:       data.city,
    });

    return clinic;
  });
}

export async function updateClinicProfile(
  clinicId: string,
  data: {
    operating_hours?: Record<string, OperatingHours>;
    departments?:     MedicalSpecialty[];
    photo_urls?:      string[];
    alternate_phone?: string;
    email?:           string;
    website_url?:     string;
  }
): Promise<ClinicProfileRow> {
  const updates: string[] = [];
  const values:  unknown[] = [];
  let   idx = 1;

  if (data.operating_hours) { updates.push(`operating_hours = $${idx++}`); values.push(JSON.stringify(data.operating_hours)); }
  if (data.departments)     { updates.push(`departments = $${idx++}`);     values.push(data.departments); }
  if (data.photo_urls)      { updates.push(`photo_urls = $${idx++}`);      values.push(data.photo_urls); }
  if (data.alternate_phone !== undefined) { updates.push(`alternate_phone = $${idx++}`); values.push(data.alternate_phone); }
  if (data.email !== undefined)           { updates.push(`email = $${idx++}`);           values.push(data.email); }
  if (data.website_url !== undefined)     { updates.push(`website_url = $${idx++}`);     values.push(data.website_url); }

  updates.push(`updated_at = NOW()`);
  values.push(clinicId);

  const result = await query<ClinicProfileRow>(
    `UPDATE clinic_profiles SET ${updates.join(', ')}
     WHERE id = $${idx} RETURNING *`,
    values
  );
  return result.rows[0];
}
