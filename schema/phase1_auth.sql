-- ============================================================
--  MEDBOOK INDIA — DATABASE SCHEMA
--  Phase 1: Users & Auth Domain
--  Database: PostgreSQL 15+
--  Convention: snake_case, UUID primary keys, timestamps on all tables
--  Author: MedBook Engineering
--  Version: 1.0 — April 2026
-- ============================================================

-- ── EXTENSIONS ───────────────────────────────────────────────
-- uuid-ossp gives us uuid_generate_v4() for primary keys
-- pgcrypto gives us secure token hashing
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";


-- ── ENUMS ────────────────────────────────────────────────────
-- We define all status types as enums upfront.
-- Enums are stored as integers in Postgres but behave like strings.
-- Benefit: enforced values, no typos, fast comparison.

-- Who is this user in the system?
CREATE TYPE user_role AS ENUM (
  'patient',
  'doctor',
  'clinic_admin',    -- the person managing a clinic account
  'platform_admin'   -- MedBook internal team
);

-- Where is the user in their account lifecycle?
CREATE TYPE account_status AS ENUM (
  'pending_verification',  -- submitted, waiting for admin review (doctors & clinics)
  'active',                -- verified and fully live
  'suspended',             -- temporarily disabled by admin
  'deactivated'            -- user-requested account closure
);

-- Which method did the user sign in with?
CREATE TYPE auth_provider AS ENUM (
  'phone_otp',   -- +91 OTP via MSG91 (primary for all users)
  'google'       -- Google OAuth (patients only)
);


-- ── TABLE: users ─────────────────────────────────────────────
-- Central authentication table. One row per person.
-- Every role (patient, doctor, clinic admin) has a row here.
-- Role-specific data lives in separate profile tables.
--
-- Design decision: We use UUID as primary key, not serial integer.
-- Reason: UUIDs are safe to expose in URLs/APIs (no enumeration attack),
-- and they work across distributed systems if we ever shard.

CREATE TABLE users (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Phone is the universal identifier in India.
  -- Unique, always +91 format, used for OTP.
  phone               VARCHAR(15) NOT NULL UNIQUE,  -- e.g. '+919876543210'

  -- Email is optional for patients, required for clinic admins.
  email               VARCHAR(255) UNIQUE,

  -- The role determines which profile table has their data.
  role                user_role NOT NULL,

  -- Account lifecycle state.
  status              account_status NOT NULL DEFAULT 'pending_verification',

  -- How they authenticated.
  auth_provider       auth_provider NOT NULL DEFAULT 'phone_otp',

  -- For Google OAuth users, we store their Google ID.
  google_id           VARCHAR(255) UNIQUE,

  -- Full name stored here for quick access without joining profile tables.
  full_name           VARCHAR(255) NOT NULL,

  -- Preferred language for notifications (WhatsApp/SMS templates).
  -- ISO 639-1 codes: 'en', 'hi', 'kn', 'ta', 'te', 'mr'
  preferred_language  VARCHAR(10) NOT NULL DEFAULT 'en',

  -- City they're based in. Used for scoping search results.
  city                VARCHAR(100),

  -- Profile photo URL (stored in S3/CloudFront).
  avatar_url          TEXT,

  -- DPDP Act 2023: we must record when and what the user consented to.
  -- Never null for active users — consent is mandatory.
  consent_given_at    TIMESTAMPTZ,
  consent_version     VARCHAR(20),  -- e.g. 'v1.0' — tracks which T&C they agreed to

  -- FCM token for push notifications. Updated on each app login.
  fcm_token           TEXT,

  -- Soft delete: we never hard-delete users (audit trail, DPDP obligations).
  -- Instead we set deleted_at and status = 'deactivated'.
  deleted_at          TIMESTAMPTZ,

  -- Standard audit timestamps on every table.
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes on users:
-- We'll query by phone constantly (login), email occasionally, role for admin queries.
CREATE INDEX idx_users_phone    ON users (phone);
CREATE INDEX idx_users_email    ON users (email) WHERE email IS NOT NULL;
CREATE INDEX idx_users_role     ON users (role);
CREATE INDEX idx_users_status   ON users (status);
CREATE INDEX idx_users_city     ON users (city) WHERE city IS NOT NULL;


-- ── TABLE: otp_verifications ──────────────────────────────────
-- Tracks OTP codes sent to phone numbers.
-- Each OTP has a short TTL. We don't store the raw OTP —
-- we store a bcrypt hash of it (security best practice).
--
-- Why a separate table and not in users?
-- Because OTP requests happen before a user account might even exist
-- (first-time registration). Keeping it separate is cleaner.

CREATE TABLE otp_verifications (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- The phone number this OTP was sent to.
  phone         VARCHAR(15) NOT NULL,

  -- Bcrypt hash of the 6-digit OTP. Never store raw OTPs.
  otp_hash      TEXT NOT NULL,

  -- OTPs expire after 5 minutes.
  expires_at    TIMESTAMPTZ NOT NULL,

  -- Track attempts to prevent brute force.
  -- After 5 failed attempts, the OTP is invalidated.
  attempt_count INTEGER NOT NULL DEFAULT 0,

  -- Once verified, mark it used so it can't be reused.
  verified_at   TIMESTAMPTZ,

  -- Which MSG91 message ID was used — for debugging delivery issues.
  provider_msg_id  VARCHAR(255),

  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- We query OTPs by phone number constantly.
CREATE INDEX idx_otp_phone      ON otp_verifications (phone);
CREATE INDEX idx_otp_expires    ON otp_verifications (expires_at);

-- Auto-cleanup: expired OTPs can be purged by a cron job.
-- In production: DELETE FROM otp_verifications WHERE expires_at < NOW() - INTERVAL '1 day';


-- ── TABLE: user_sessions ──────────────────────────────────────
-- Tracks active sessions (JWT refresh tokens).
-- When a user logs in, we create a session row.
-- On logout or 30-day inactivity, we revoke it.
--
-- Why track sessions if we use JWT?
-- JWTs are stateless but we need to be able to revoke them
-- (e.g., if a phone is stolen). We store the refresh token hash here.

CREATE TABLE user_sessions (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Hash of the refresh token. Never store raw tokens.
  refresh_token_hash TEXT NOT NULL UNIQUE,

  -- Device info for the user to see "active sessions" and revoke.
  device_name       VARCHAR(255),   -- e.g. 'Samsung Galaxy A52'
  device_os         VARCHAR(50),    -- e.g. 'Android 13'
  ip_address        INET,

  -- When this session was last used (updated on each API call).
  last_active_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Session expires 30 days after last activity.
  expires_at        TIMESTAMPTZ NOT NULL,

  -- Revoked sessions are kept for 7 days then purged (audit trail).
  revoked_at        TIMESTAMPTZ,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sessions_user_id   ON user_sessions (user_id);
CREATE INDEX idx_sessions_expires   ON user_sessions (expires_at);
CREATE INDEX idx_sessions_active    ON user_sessions (last_active_at);


-- ── TABLE: patient_profiles ───────────────────────────────────
-- Extended data for users with role = 'patient'.
-- One row per patient user.
-- Joined with users table when we need full patient data.

CREATE TABLE patient_profiles (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- 1:1 relationship with users table.
  user_id         UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,

  -- Date of birth for age-appropriate content and records.
  date_of_birth   DATE,

  -- Gender (optional, patient's choice).
  gender          VARCHAR(20),   -- 'male', 'female', 'other', 'prefer_not_to_say'

  -- Blood group — useful for medical context.
  blood_group     VARCHAR(5),    -- 'A+', 'B-', 'O+', 'AB+', etc.

  -- Emergency contact details.
  emergency_contact_name   VARCHAR(255),
  emergency_contact_phone  VARCHAR(15),

  -- JSONB for flexible, optional health data (allergies, chronic conditions).
  -- We don't force structure here — it's patient-provided, optional.
  -- Example: { "allergies": ["penicillin"], "conditions": ["diabetes"] }
  health_notes    JSONB DEFAULT '{}',

  -- Total bookings made — denormalised counter for quick stats.
  -- Incremented by trigger on bookings table insert.
  total_bookings  INTEGER NOT NULL DEFAULT 0,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_patient_profiles_user_id ON patient_profiles (user_id);


-- ── TRIGGER: auto-update updated_at ──────────────────────────
-- We create a reusable trigger function that updates updated_at
-- automatically on every UPDATE. Apply this to all tables.

CREATE OR REPLACE FUNCTION trigger_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply to users
CREATE TRIGGER set_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- Apply to patient_profiles
CREATE TRIGGER set_patient_profiles_updated_at
  BEFORE UPDATE ON patient_profiles
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();


-- ── SEED: Platform Admin ──────────────────────────────────────
-- Create the first platform admin account.
-- In production: replace phone and name with real values.
-- Status is set to 'active' directly — admin doesn't need verification.

INSERT INTO users (
  phone, role, status, full_name, preferred_language,
  consent_given_at, consent_version
) VALUES (
  '+919999999999',
  'platform_admin',
  'active',
  'MedBook Admin',
  'en',
  NOW(),
  'v1.0'
);


-- ============================================================
--  END OF PHASE 1: USERS & AUTH
--
--  Tables created:
--    users                 — central auth table for all roles
--    otp_verifications     — OTP codes with TTL and attempt tracking
--    user_sessions         — refresh token tracking for JWT revocation
--    patient_profiles      — extended data for patient users
--
--  Enums created:
--    user_role             — patient | doctor | clinic_admin | platform_admin
--    account_status        — pending_verification | active | suspended | deactivated
--    auth_provider         — phone_otp | google
--
--  Next: Phase 2 — Doctor Profiles & Clinic Profiles
-- ============================================================
