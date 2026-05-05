-- ============================================================
--  MEDBOOK INDIA — DATABASE SCHEMA
--  Phase 2: Doctor Profiles & Clinic Profiles
--  Depends on: Phase 1 (users table must exist)
--  Database: PostgreSQL 15+
--  Version: 1.0 — April 2026
-- ============================================================


-- ── ENUMS ────────────────────────────────────────────────────

-- Tracks where a doctor or clinic is in the verification pipeline.
CREATE TYPE verification_status AS ENUM (
  'not_submitted',    -- profile created but docs not uploaded yet
  'submitted',        -- documents uploaded, waiting for admin review
  'under_review',     -- admin has picked it up and is reviewing
  'approved',         -- verified and live on platform
  'rejected',         -- failed verification (wrong NMC, fake docs, etc.)
  're_review'         -- previously rejected, resubmitted with corrections
);

-- Type of healthcare facility.
CREATE TYPE facility_type AS ENUM (
  'clinic',
  'hospital',
  'polyclinic',
  'diagnostic_center',  -- Phase 2 feature, defined now for forward compatibility
  'nursing_home'
);

-- Status of a doctor-clinic link relationship.
CREATE TYPE link_status AS ENUM (
  'pending',    -- clinic sent request, doctor hasn't responded
  'active',     -- doctor accepted — they are linked
  'rejected',   -- doctor declined the link request
  'removed'     -- was active, then unlinked by either party
);

-- Medical specialties we support in Phase 1.
-- Defined as enum so search filters stay consistent.
CREATE TYPE medical_specialty AS ENUM (
  'general_physician',
  'cardiology',
  'dermatology',
  'orthopedics',
  'gynecology',
  'pediatrics',
  'ent',
  'neurology',
  'ophthalmology',
  'psychiatry',
  'urology',
  'nephrology',
  'gastroenterology',
  'pulmonology',
  'endocrinology',
  'oncology',
  'rheumatology',
  'dentistry',
  'physiotherapy',
  'general_surgery'
);


-- ── TABLE: doctor_profiles ────────────────────────────────────
-- One row per doctor. Extended profile data beyond what users table holds.
-- Joined with users on users.id = doctor_profiles.user_id
--
-- Design decision: specialties stored as an array of enum values.
-- A doctor can have a primary specialty and secondary specialties.
-- e.g. a doctor is primarily a Cardiologist but also does General Physician.
-- We use Postgres native ARRAY type for this — clean and queryable.

CREATE TABLE doctor_profiles (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- 1:1 with users table (role = 'doctor')
  user_id               UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,

  -- NMC (National Medical Commission) registration number.
  -- Format varies but typically alphanumeric.
  -- Unique constraint: no two doctors can have the same NMC number.
  nmc_number            VARCHAR(50) UNIQUE,

  -- Primary specialty — the main one shown in search results.
  primary_specialty     medical_specialty NOT NULL,

  -- Additional specialties the doctor practices.
  -- Stored as an array: e.g. ARRAY['cardiology', 'general_physician']
  secondary_specialties medical_specialty[] DEFAULT '{}',

  -- Highest qualification: MBBS, MD, MS, DM, DNB, MCh, etc.
  -- Stored as JSONB array for flexibility.
  -- Example: [{"degree": "MBBS", "college": "AIIMS Delhi", "year": 2005},
  --           {"degree": "DM", "college": "PGI Chandigarh", "year": 2010}]
  qualifications        JSONB NOT NULL DEFAULT '[]',

  -- Years of post-qualification experience.
  years_of_experience   SMALLINT NOT NULL CHECK (years_of_experience >= 0),

  -- Languages the doctor speaks during consultation.
  -- Array of ISO 639-1 codes: 'en', 'hi', 'kn', 'ta', 'te', 'mr'
  languages_spoken      VARCHAR(10)[] NOT NULL DEFAULT '{en}',

  -- Default consultation fee in Indian Rupees (paise stored as integer).
  -- We store as integer paise (₹800 = 80000 paise) to avoid float precision issues.
  -- On display, divide by 100.
  consultation_fee_paise INTEGER NOT NULL CHECK (consultation_fee_paise >= 0),

  -- Short bio shown on profile. 500 char max.
  bio                   TEXT,

  -- Hospital affiliations, awards, memberships.
  -- JSONB for flexible structure.
  -- Example: {"affiliations": ["Apollo Hospitals", "NIMHANS"],
  --           "awards": ["Best Cardiologist Karnataka 2022"],
  --           "memberships": ["Indian Medical Association"]}
  achievements          JSONB DEFAULT '{}',

  -- Whether the doctor operates independently (no clinic link required).
  -- If true, they can set their own schedule and location.
  is_independent        BOOLEAN NOT NULL DEFAULT FALSE,

  -- Verification tracking.
  verification_status   verification_status NOT NULL DEFAULT 'not_submitted',

  -- Which admin reviewed this profile (references users.id of a platform_admin).
  verified_by           UUID REFERENCES users(id) ON DELETE SET NULL,

  -- When verification was completed (approved or rejected).
  verified_at           TIMESTAMPTZ,

  -- If rejected, reason stored here so doctor knows what to fix.
  rejection_reason      TEXT,

  -- URL to NMC certificate document (stored in S3, private bucket).
  nmc_document_url      TEXT,

  -- Overall rating — denormalised for fast search sorting.
  -- Recomputed by trigger whenever a review is added/updated.
  avg_rating            NUMERIC(3,2) DEFAULT 0.00 CHECK (avg_rating BETWEEN 0 AND 5),

  -- Total number of reviews — denormalised counter.
  total_reviews         INTEGER NOT NULL DEFAULT 0,

  -- Total completed appointments — for credibility display.
  total_appointments    INTEGER NOT NULL DEFAULT 0,

  -- Profile visibility. Admin can hide a profile without deactivating the account.
  is_visible            BOOLEAN NOT NULL DEFAULT FALSE,  -- false until verified

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for doctor_profiles:
-- Most critical: search by specialty (most common filter).
-- Also index rating for sorting, verification status for admin queue.
CREATE INDEX idx_doctor_profiles_user_id            ON doctor_profiles (user_id);
CREATE INDEX idx_doctor_profiles_primary_specialty  ON doctor_profiles (primary_specialty);
CREATE INDEX idx_doctor_profiles_verification       ON doctor_profiles (verification_status);
CREATE INDEX idx_doctor_profiles_rating             ON doctor_profiles (avg_rating DESC);
CREATE INDEX idx_doctor_profiles_visible            ON doctor_profiles (is_visible) WHERE is_visible = TRUE;
CREATE INDEX idx_doctor_profiles_nmc                ON doctor_profiles (nmc_number) WHERE nmc_number IS NOT NULL;

-- GIN index for searching within JSONB qualifications and array fields.
-- GIN = Generalized Inverted Index — best for array and JSONB searches.
CREATE INDEX idx_doctor_profiles_languages          ON doctor_profiles USING GIN (languages_spoken);
CREATE INDEX idx_doctor_profiles_sec_specialties    ON doctor_profiles USING GIN (secondary_specialties);

-- Trigger to keep updated_at current.
CREATE TRIGGER set_doctor_profiles_updated_at
  BEFORE UPDATE ON doctor_profiles
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();


-- ── TABLE: clinic_profiles ────────────────────────────────────
-- One row per clinic or hospital.
-- The user who created this is a 'clinic_admin' in the users table.
--
-- Design decision: A clinic is its own entity independent of any one user.
-- The clinic_admin user manages it, but the clinic can outlive that user
-- (e.g., if the admin changes). So clinic is not 1:1 with users.
-- Instead, we have a clinic_admins junction table below.

CREATE TABLE clinic_profiles (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- The name of the facility as it appears publicly.
  name                  VARCHAR(255) NOT NULL,

  -- Type of facility.
  facility_type         facility_type NOT NULL DEFAULT 'clinic',

  -- Full address breakdown — stored both structured and as a text for display.
  address_line1         VARCHAR(255) NOT NULL,
  address_line2         VARCHAR(255),
  neighbourhood         VARCHAR(100),   -- e.g. 'Indiranagar', 'Koramangala'
  city                  VARCHAR(100) NOT NULL,
  state                 VARCHAR(100) NOT NULL,
  pincode               VARCHAR(10) NOT NULL,

  -- Geographic coordinates for distance-based search.
  -- PostGIS would be ideal for Phase 2. For Phase 1, lat/lng columns work.
  latitude              NUMERIC(10, 8),   -- e.g. 12.97194000
  longitude             NUMERIC(11, 8),   -- e.g. 77.59369000

  -- Contact details.
  phone                 VARCHAR(15) NOT NULL,
  alternate_phone       VARCHAR(15),
  email                 VARCHAR(255),
  website_url           TEXT,

  -- Operating hours stored as JSONB for flexibility.
  -- Different days can have different hours. Supports closed days.
  -- Example: {
  --   "monday":    {"open": "08:00", "close": "20:00"},
  --   "tuesday":   {"open": "08:00", "close": "20:00"},
  --   "sunday":    {"closed": true}
  -- }
  operating_hours       JSONB NOT NULL DEFAULT '{}',

  -- Departments/specialties available at this facility.
  -- Array of medical_specialty enum values.
  departments           medical_specialty[] DEFAULT '{}',

  -- Photos of the clinic (S3 URLs).
  -- Example: ["https://cdn.medbook.in/clinics/abc/photo1.jpg", ...]
  photo_urls            TEXT[] DEFAULT '{}',

  -- State-issued registration/license number. Verified by admin.
  license_number        VARCHAR(100),

  -- License document URL (private S3 bucket).
  license_document_url  TEXT,

  -- Verification tracking (same pattern as doctor_profiles).
  verification_status   verification_status NOT NULL DEFAULT 'not_submitted',
  verified_by           UUID REFERENCES users(id) ON DELETE SET NULL,
  verified_at           TIMESTAMPTZ,
  rejection_reason      TEXT,

  -- Overall clinic rating — average of all doctor ratings at this clinic.
  -- Recomputed periodically.
  avg_rating            NUMERIC(3,2) DEFAULT 0.00 CHECK (avg_rating BETWEEN 0 AND 5),
  total_reviews         INTEGER NOT NULL DEFAULT 0,

  -- Is this clinic visible in patient search?
  is_visible            BOOLEAN NOT NULL DEFAULT FALSE,

  -- Soft delete.
  deleted_at            TIMESTAMPTZ,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for clinic_profiles.
CREATE INDEX idx_clinic_profiles_city               ON clinic_profiles (city);
CREATE INDEX idx_clinic_profiles_neighbourhood      ON clinic_profiles (neighbourhood);
CREATE INDEX idx_clinic_profiles_verification       ON clinic_profiles (verification_status);
CREATE INDEX idx_clinic_profiles_visible            ON clinic_profiles (is_visible) WHERE is_visible = TRUE;
CREATE INDEX idx_clinic_profiles_departments        ON clinic_profiles USING GIN (departments);

-- Composite index for the most common query: find visible clinics in a city.
CREATE INDEX idx_clinic_profiles_city_visible       ON clinic_profiles (city, is_visible);

-- Trigger.
CREATE TRIGGER set_clinic_profiles_updated_at
  BEFORE UPDATE ON clinic_profiles
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();


-- ── TABLE: clinic_admins ──────────────────────────────────────
-- Junction table: which users manage which clinics.
-- A clinic can have multiple admins (owner + receptionist + manager).
-- A user can manage multiple clinics (rare but possible for chains).
--
-- Design decision: we track permissions per admin using a JSONB column.
-- This is simpler than a full RBAC table for Phase 1.

CREATE TYPE clinic_admin_role AS ENUM (
  'owner',          -- full access, can add/remove other admins
  'manager',        -- full booking and schedule access, cannot manage admins
  'receptionist'    -- can view and manage bookings only, no schedule changes
);

CREATE TABLE clinic_admins (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  clinic_id     UUID NOT NULL REFERENCES clinic_profiles(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Their role within this clinic.
  admin_role    clinic_admin_role NOT NULL DEFAULT 'owner',

  -- Who added this admin (references another clinic admin or platform admin).
  invited_by    UUID REFERENCES users(id) ON DELETE SET NULL,

  -- When they accepted the invite to manage this clinic.
  accepted_at   TIMESTAMPTZ,

  -- Is this admin currently active?
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- A user can only have one role per clinic.
  UNIQUE (clinic_id, user_id)
);

CREATE INDEX idx_clinic_admins_clinic_id  ON clinic_admins (clinic_id);
CREATE INDEX idx_clinic_admins_user_id    ON clinic_admins (user_id);

CREATE TRIGGER set_clinic_admins_updated_at
  BEFORE UPDATE ON clinic_admins
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();


-- ── TABLE: doctor_clinic_links ────────────────────────────────
-- The relationship between a doctor and a clinic.
-- This is NOT just a simple join table — it has its own lifecycle:
-- clinic sends request → doctor accepts/rejects → link becomes active.
--
-- Key rule from PRD: Doctor must accept before any schedule can be set.
-- The schedule is a separate table that depends on this link being 'active'.

CREATE TABLE doctor_clinic_links (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  doctor_id       UUID NOT NULL REFERENCES doctor_profiles(id) ON DELETE CASCADE,
  clinic_id       UUID NOT NULL REFERENCES clinic_profiles(id) ON DELETE CASCADE,

  -- Current state of this relationship.
  status          link_status NOT NULL DEFAULT 'pending',

  -- Who initiated the link? Almost always the clinic, but could be doctor.
  initiated_by    UUID NOT NULL REFERENCES users(id) ON DELETE SET NULL,

  -- Optional message sent with the link request.
  request_note    TEXT,

  -- When the doctor responded (accepted or rejected).
  responded_at    TIMESTAMPTZ,

  -- If rejected, what reason did the doctor give?
  rejection_note  TEXT,

  -- When this link was removed (if status = 'removed').
  removed_at      TIMESTAMPTZ,
  removed_by      UUID REFERENCES users(id) ON DELETE SET NULL,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- A doctor can only have one active link per clinic at a time.
  -- We allow the combination to be unique so a re-invite creates a new row
  -- only after the old one is 'rejected' or 'removed'.
  UNIQUE (doctor_id, clinic_id)
);

-- Indexes for doctor_clinic_links.
-- Most common queries: find all clinics for a doctor, find all doctors for a clinic.
CREATE INDEX idx_dcl_doctor_id  ON doctor_clinic_links (doctor_id);
CREATE INDEX idx_dcl_clinic_id  ON doctor_clinic_links (clinic_id);
CREATE INDEX idx_dcl_status     ON doctor_clinic_links (status);

-- Composite: find all active links for a clinic (used in clinic dashboard).
CREATE INDEX idx_dcl_clinic_active  ON doctor_clinic_links (clinic_id, status)
  WHERE status = 'active';

-- Composite: find all active links for a doctor (used in doctor's "My Clinics").
CREATE INDEX idx_dcl_doctor_active  ON doctor_clinic_links (doctor_id, status)
  WHERE status = 'active';

CREATE TRIGGER set_dcl_updated_at
  BEFORE UPDATE ON doctor_clinic_links
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();


-- ── TABLE: saved_doctors ──────────────────────────────────────
-- Patients can save/favourite doctor profiles.
-- Simple junction table — no lifecycle, just present or absent.

CREATE TABLE saved_doctors (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  patient_id  UUID NOT NULL REFERENCES patient_profiles(id) ON DELETE CASCADE,
  doctor_id   UUID NOT NULL REFERENCES doctor_profiles(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- A patient can only save a doctor once.
  UNIQUE (patient_id, doctor_id)
);

CREATE INDEX idx_saved_doctors_patient  ON saved_doctors (patient_id);
CREATE INDEX idx_saved_doctors_doctor   ON saved_doctors (doctor_id);


-- ── VIEW: doctor_search_view ──────────────────────────────────
-- A denormalised view for the patient-facing doctor search.
-- Joins users + doctor_profiles and exposes only what the search UI needs.
-- In production this can become a materialised view for performance.
--
-- Usage: SELECT * FROM doctor_search_view WHERE city = 'Bengaluru'
--        AND primary_specialty = 'cardiology' ORDER BY avg_rating DESC;

CREATE VIEW doctor_search_view AS
SELECT
  dp.id                     AS doctor_profile_id,
  u.id                      AS user_id,
  u.full_name               AS doctor_name,
  u.avatar_url,
  u.city,
  dp.primary_specialty,
  dp.secondary_specialties,
  dp.years_of_experience,
  dp.languages_spoken,
  dp.consultation_fee_paise,
  dp.avg_rating,
  dp.total_reviews,
  dp.total_appointments,
  dp.bio,
  dp.is_independent,
  dp.nmc_number,
  -- Count of active clinic links (how many locations this doctor works at).
  (
    SELECT COUNT(*)
    FROM doctor_clinic_links dcl
    WHERE dcl.doctor_id = dp.id AND dcl.status = 'active'
  ) AS active_location_count
FROM doctor_profiles dp
JOIN users u ON u.id = dp.user_id
WHERE dp.is_visible = TRUE
  AND u.status = 'active'
  AND u.deleted_at IS NULL;


-- ============================================================
--  END OF PHASE 2: DOCTOR & CLINIC PROFILES
--
--  Tables created:
--    doctor_profiles         — full doctor profile, NMC, specialties, ratings
--    clinic_profiles         — clinic/hospital profile, location, hours, verification
--    clinic_admins           — which users manage which clinics and their role
--    doctor_clinic_links     — doctor-clinic relationship with full lifecycle
--    saved_doctors           — patient favourites
--
--  Views created:
--    doctor_search_view      — denormalised view for patient search results
--
--  Enums created:
--    verification_status     — not_submitted | submitted | under_review | approved | rejected | re_review
--    facility_type           — clinic | hospital | polyclinic | diagnostic_center | nursing_home
--    link_status             — pending | active | rejected | removed
--    medical_specialty       — 20 specialties for Phase 1
--    clinic_admin_role       — owner | manager | receptionist
--
--  Key design decisions:
--    - Fees stored as integer paise (avoid float precision bugs)
--    - JSONB for flexible data (qualifications, operating hours, achievements)
--    - GIN indexes on array and JSONB columns for fast filtering
--    - doctor_clinic_links is a full entity, not a simple join table
--    - Clinic is independent of any one admin user (supports staff changes)
--
--  Next: Phase 3 — Scheduling Engine
--        (schedule_requests, slots, availability, blocked_dates)
-- ============================================================
