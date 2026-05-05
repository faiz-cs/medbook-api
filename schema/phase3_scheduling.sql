-- ============================================================
--  MEDBOOK INDIA — DATABASE SCHEMA
--  Phase 3: The Scheduling Engine
--  Depends on: Phase 1 (users), Phase 2 (doctor_profiles,
--              clinic_profiles, doctor_clinic_links)
--  Database: PostgreSQL 15+
--  Version: 1.0 — April 2026
-- ============================================================


-- ── ENUMS ────────────────────────────────────────────────────

-- Lifecycle of a schedule request from clinic to doctor.
CREATE TYPE schedule_request_status AS ENUM (
  'pending',          -- sent to doctor, awaiting response
  'approved',         -- doctor accepted — rule goes live
  'rejected',         -- doctor declined
  'counter_proposed', -- doctor suggested alternative timings
  'expired',          -- no response after 72 hours
  'cancelled'         -- clinic withdrew the request before doctor responded
);

-- Status of a generated time slot.
CREATE TYPE slot_status AS ENUM (
  'available',    -- open for booking
  'booked',       -- a confirmed booking exists for this slot
  'blocked',      -- blocked by doctor (vacation, blocked date)
  'closed',       -- clinic closed this slot manually
  'expired'       -- slot time has passed without a booking
);

-- Days of week as an enum for clean storage in schedule rules.
-- Stored as an array in schedule_rules.
CREATE TYPE day_of_week AS ENUM (
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday'
);


-- ── TABLE: schedule_requests ──────────────────────────────────
-- Every time a clinic wants to set or change a doctor's schedule
-- at their facility, they create a schedule_request.
--
-- PRD Rule: Nothing goes live until doctor explicitly approves.
-- This table is the gatekeeper for that rule.
--
-- A request can be for:
--   (a) A brand new schedule (first time linking)
--   (b) A modification to an existing approved schedule
--   (c) A removal of a schedule (clinic no longer needs doctor)
--
-- Design decision: We never mutate an approved schedule directly.
-- Every change creates a NEW schedule_request that must be approved.
-- The old schedule stays live until the new one is approved.
-- This prevents patients from losing their existing bookings silently.

CREATE TABLE schedule_requests (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Which doctor-clinic relationship this request is for.
  -- Must be an active link for a request to be valid.
  doctor_clinic_link_id UUID NOT NULL REFERENCES doctor_clinic_links(id)
                          ON DELETE CASCADE,

  -- Denormalised for quick access without joining.
  doctor_id             UUID NOT NULL REFERENCES doctor_profiles(id)
                          ON DELETE CASCADE,
  clinic_id             UUID NOT NULL REFERENCES clinic_profiles(id)
                          ON DELETE CASCADE,

  -- Who created this request (a clinic_admin user).
  requested_by          UUID NOT NULL REFERENCES users(id)
                          ON DELETE SET NULL,

  -- Current state of this request.
  status                schedule_request_status NOT NULL DEFAULT 'pending',

  -- ── Proposed Schedule Details ──────────────────────────────
  -- Days of week this schedule applies to.
  -- Stored as an array: e.g. ARRAY['monday','wednesday','friday']
  proposed_days         day_of_week[] NOT NULL,

  -- Start and end times stored as TIME (no date, no timezone).
  -- Times are always interpreted as IST (India Standard Time).
  -- e.g. '08:00:00' and '13:00:00'
  proposed_start_time   TIME NOT NULL,
  proposed_end_time     TIME NOT NULL,

  -- How long each appointment slot is, in minutes.
  -- e.g. 15, 20, 30, 45, 60
  slot_duration_minutes SMALLINT NOT NULL CHECK (slot_duration_minutes IN (10,15,20,30,45,60)),

  -- Maximum number of patients per day at this location.
  max_patients_per_day  SMALLINT NOT NULL CHECK (max_patients_per_day > 0),

  -- When this schedule should start being live (if approved).
  -- Cannot be in the past.
  effective_from        DATE NOT NULL,

  -- When this schedule ends. NULL = no end date (ongoing).
  effective_until       DATE,

  -- Optional note from clinic to doctor explaining the request.
  clinic_note           TEXT,

  -- ── Doctor Response ────────────────────────────────────────
  -- When the doctor viewed this request in their app.
  viewed_at             TIMESTAMPTZ,

  -- When the doctor responded.
  responded_at          TIMESTAMPTZ,

  -- If rejected: doctor's reason.
  rejection_note        TEXT,

  -- If counter-proposed: the doctor's suggested alternative.
  -- Stored as JSONB to keep it flexible.
  -- Example: {
  --   "days": ["tuesday", "thursday"],
  --   "start_time": "14:00",
  --   "end_time": "18:00",
  --   "note": "Mornings are taken at City Clinic"
  -- }
  counter_proposal      JSONB,

  -- ── Escalation Tracking ────────────────────────────────────
  -- When the 48-hour reminder notification was sent.
  reminder_sent_at      TIMESTAMPTZ,

  -- When the 72-hour escalation notification was sent to clinic.
  escalation_sent_at    TIMESTAMPTZ,

  -- ── Link to Approved Rule ──────────────────────────────────
  -- Once approved, this request spawns a schedule_rule.
  -- We store the reference here for traceability.
  resulting_rule_id     UUID,  -- FK added after schedule_rules table is created

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Business rule: start time must be before end time.
  CONSTRAINT chk_schedule_times CHECK (proposed_start_time < proposed_end_time),

  -- Business rule: effective_until must be after effective_from.
  CONSTRAINT chk_effective_dates CHECK (
    effective_until IS NULL OR effective_until > effective_from
  )
);

-- Indexes for schedule_requests.
CREATE INDEX idx_sr_doctor_id     ON schedule_requests (doctor_id);
CREATE INDEX idx_sr_clinic_id     ON schedule_requests (clinic_id);
CREATE INDEX idx_sr_status        ON schedule_requests (status);
CREATE INDEX idx_sr_link_id       ON schedule_requests (doctor_clinic_link_id);

-- Critical: find all pending requests for a doctor (approval inbox).
CREATE INDEX idx_sr_doctor_pending ON schedule_requests (doctor_id, status)
  WHERE status = 'pending';

-- For escalation job: find pending requests past 48h with no reminder sent.
CREATE INDEX idx_sr_escalation    ON schedule_requests (created_at, status, reminder_sent_at)
  WHERE status = 'pending';

CREATE TRIGGER set_sr_updated_at
  BEFORE UPDATE ON schedule_requests
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();


-- ── TABLE: schedule_rules ─────────────────────────────────────
-- An approved schedule rule. Created when a doctor approves a
-- schedule_request. This is the source of truth for slot generation.
--
-- Design decision: schedule_rules are IMMUTABLE once created.
-- If a clinic wants to change the schedule, they create a new
-- schedule_request. On approval, the old rule is deactivated and
-- a new rule is created. This preserves the audit trail completely.
--
-- The slot generator reads active schedule_rules every night
-- and generates time_slots for the next 60 days.

CREATE TABLE schedule_rules (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- The request that created this rule (full traceability).
  schedule_request_id   UUID NOT NULL REFERENCES schedule_requests(id)
                          ON DELETE RESTRICT,

  -- Denormalised for fast slot generation queries.
  doctor_id             UUID NOT NULL REFERENCES doctor_profiles(id)
                          ON DELETE CASCADE,
  clinic_id             UUID NOT NULL REFERENCES clinic_profiles(id)
                          ON DELETE CASCADE,
  doctor_clinic_link_id UUID NOT NULL REFERENCES doctor_clinic_links(id)
                          ON DELETE CASCADE,

  -- The approved schedule parameters (copied from schedule_request).
  active_days           day_of_week[] NOT NULL,
  start_time            TIME NOT NULL,
  end_time              TIME NOT NULL,
  slot_duration_minutes SMALLINT NOT NULL,
  max_patients_per_day  SMALLINT NOT NULL,

  -- Date range this rule is valid for.
  effective_from        DATE NOT NULL,
  effective_until       DATE,       -- NULL = no end, ongoing rule

  -- Is this rule currently being used for slot generation?
  -- Set to FALSE when superseded by a new rule.
  is_active             BOOLEAN NOT NULL DEFAULT TRUE,

  -- When this rule was deactivated (superseded or clinic removed doctor).
  deactivated_at        TIMESTAMPTZ,
  deactivated_by        UUID REFERENCES users(id) ON DELETE SET NULL,

  -- When was the last slot generation run for this rule?
  -- The nightly job updates this after generating slots.
  last_generated_until  DATE,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Now add the FK from schedule_requests back to schedule_rules.
ALTER TABLE schedule_requests
  ADD CONSTRAINT fk_sr_resulting_rule
  FOREIGN KEY (resulting_rule_id) REFERENCES schedule_rules(id)
  ON DELETE SET NULL;

-- Indexes for schedule_rules.
CREATE INDEX idx_rule_doctor_id   ON schedule_rules (doctor_id);
CREATE INDEX idx_rule_clinic_id   ON schedule_rules (clinic_id);

-- The slot generator queries this index every night.
CREATE INDEX idx_rule_active      ON schedule_rules (is_active, effective_from, effective_until)
  WHERE is_active = TRUE;

-- For doctor's "My Schedule" screen: active rules per doctor.
CREATE INDEX idx_rule_doctor_active ON schedule_rules (doctor_id, is_active)
  WHERE is_active = TRUE;

CREATE TRIGGER set_rule_updated_at
  BEFORE UPDATE ON schedule_rules
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();


-- ── TABLE: time_slots ─────────────────────────────────────────
-- Individual bookable appointment slots.
-- Generated nightly by the slot generator from schedule_rules.
--
-- This is the HIGHEST TRAFFIC table in the system.
-- Every patient search reads it. Every booking writes to it.
-- Every cancellation updates it. Index design is critical here.
--
-- Design decision: One row per slot per day.
-- e.g. Dr. Ramesh at Apollo Clinic on Mon 14 Apr has 10 slots:
--   09:00, 09:30, 10:00, 10:30, 11:00, 11:30, 12:00, 12:30, 13:00
-- = 9 rows in time_slots.
--
-- Slot locking for concurrent booking:
-- We use PostgreSQL's SELECT FOR UPDATE on a slot row when a patient
-- is in the checkout flow. This locks the row for up to 5 minutes.
-- If they don't confirm, the lock is released. This prevents
-- two patients booking the same slot simultaneously.

CREATE TABLE time_slots (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Which rule generated this slot (for traceability and bulk operations).
  schedule_rule_id      UUID NOT NULL REFERENCES schedule_rules(id)
                          ON DELETE CASCADE,

  -- Denormalised for fast querying without joins.
  doctor_id             UUID NOT NULL REFERENCES doctor_profiles(id)
                          ON DELETE CASCADE,
  clinic_id             UUID NOT NULL REFERENCES clinic_profiles(id)
                          ON DELETE CASCADE,

  -- The actual date and time of this slot.
  -- slot_date: the calendar date (e.g., 2026-04-14)
  -- slot_start_time: when it starts (e.g., 09:30:00)
  -- slot_end_time: when it ends (e.g., 10:00:00)
  -- We store them separately AND as a combined TIMESTAMPTZ for range queries.
  slot_date             DATE NOT NULL,
  slot_start_time       TIME NOT NULL,
  slot_end_time         TIME NOT NULL,

  -- Full timestamp (IST offset stored). For range queries and sorting.
  -- e.g. '2026-04-14 09:30:00+05:30'
  slot_start_at         TIMESTAMPTZ NOT NULL,
  slot_end_at           TIMESTAMPTZ NOT NULL,

  -- Current status of this slot.
  status                slot_status NOT NULL DEFAULT 'available',

  -- Duration in minutes (denormalised from rule for display).
  duration_minutes      SMALLINT NOT NULL,

  -- Is this slot currently being held by a patient in checkout?
  -- True = locked. The booking_id will be set to the in-progress booking.
  -- Lock expires after 5 minutes if booking not confirmed.
  is_locked             BOOLEAN NOT NULL DEFAULT FALSE,
  locked_at             TIMESTAMPTZ,
  locked_by_session     UUID,   -- references user_sessions.id (not FK, for performance)

  -- Once booked, this references the confirmed booking.
  -- NULL until a booking is confirmed for this slot.
  booking_id            UUID,   -- FK added after bookings table is created

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- No duplicate slots: a doctor at a clinic can only have one slot
  -- at any given start time on any given date.
  UNIQUE (doctor_id, clinic_id, slot_date, slot_start_time)
);

-- ── CRITICAL INDEXES for time_slots ──────────────────────────
-- This table needs the most careful indexing in the entire schema.

-- Primary patient search query:
-- "Show me available slots for Dr. X at Clinic Y from today onwards"
CREATE INDEX idx_slots_doctor_clinic_date ON time_slots
  (doctor_id, clinic_id, slot_date, slot_start_time)
  WHERE status = 'available';

-- For the doctor profile page: show all available slots across all clinics.
CREATE INDEX idx_slots_doctor_available ON time_slots
  (doctor_id, slot_date, slot_start_time)
  WHERE status = 'available';

-- For the slot generator: find what's already been generated for a rule.
CREATE INDEX idx_slots_rule_date ON time_slots (schedule_rule_id, slot_date);

-- For the lock expiry job: find stale locks to release.
CREATE INDEX idx_slots_locked ON time_slots (locked_at)
  WHERE is_locked = TRUE;

-- For the expiry job: mark past available slots as expired.
CREATE INDEX idx_slots_expiry ON time_slots (slot_start_at, status)
  WHERE status = 'available';

-- For clinic dashboard: today's slots at a clinic.
CREATE INDEX idx_slots_clinic_date ON time_slots (clinic_id, slot_date);

CREATE TRIGGER set_slots_updated_at
  BEFORE UPDATE ON time_slots
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();


-- ── TABLE: blocked_dates ──────────────────────────────────────
-- A doctor can block specific dates or date ranges across
-- all their locations (or optionally at one specific clinic).
--
-- When a blocked_date is created:
--   1. All time_slots for that doctor on those dates → status = 'blocked'
--   2. Any existing bookings on those dates → patients notified + offered reschedule
--   3. A background job handles the cascade update.
--
-- Design decision: blocked_dates applies to the DOCTOR globally by default,
-- not to a specific clinic. A doctor on vacation is unavailable everywhere.
-- But we support clinic-specific blocking too (e.g., only blocking
-- a specific location for a specific reason).

CREATE TYPE block_reason AS ENUM (
  'vacation',
  'conference',
  'personal',
  'medical_leave',
  'public_holiday',
  'clinic_closure',   -- clinic blocked the doctor at their location only
  'other'
);

CREATE TABLE blocked_dates (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- The doctor this block applies to.
  doctor_id         UUID NOT NULL REFERENCES doctor_profiles(id)
                      ON DELETE CASCADE,

  -- If NULL: block applies at ALL clinics.
  -- If set: block applies only at this specific clinic.
  clinic_id         UUID REFERENCES clinic_profiles(id) ON DELETE CASCADE,

  -- Date range of the block (inclusive on both ends).
  block_from        DATE NOT NULL,
  block_until       DATE NOT NULL,

  -- Why the doctor is unavailable.
  reason            block_reason NOT NULL DEFAULT 'personal',

  -- Optional note (shown to admin, not to patients).
  note              TEXT,

  -- Who created this block?
  created_by        UUID NOT NULL REFERENCES users(id) ON DELETE SET NULL,

  -- Has the slot cascade update been processed?
  -- The background job sets this to TRUE after updating all affected slots.
  slots_updated     BOOLEAN NOT NULL DEFAULT FALSE,
  slots_updated_at  TIMESTAMPTZ,

  -- Has the affected bookings notification been sent?
  bookings_notified   BOOLEAN NOT NULL DEFAULT FALSE,
  bookings_notified_at TIMESTAMPTZ,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Block end must be on or after block start.
  CONSTRAINT chk_block_dates CHECK (block_until >= block_from)
);

-- Indexes for blocked_dates.
CREATE INDEX idx_blocked_doctor_id    ON blocked_dates (doctor_id);
CREATE INDEX idx_blocked_dates_range  ON blocked_dates (doctor_id, block_from, block_until);

-- For the background job: find unprocessed blocks.
CREATE INDEX idx_blocked_unprocessed  ON blocked_dates (slots_updated)
  WHERE slots_updated = FALSE;

CREATE TRIGGER set_blocked_dates_updated_at
  BEFORE UPDATE ON blocked_dates
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();


-- ── FUNCTION: generate_slots_for_rule() ───────────────────────
-- The core slot generation function.
-- Called by the nightly background job for each active schedule_rule.
-- Generates slots from (last_generated_until + 1 day) up to 60 days ahead.
--
-- This function is idempotent: running it twice for the same rule
-- will not create duplicate slots (INSERT ... ON CONFLICT DO NOTHING).

CREATE OR REPLACE FUNCTION generate_slots_for_rule(p_rule_id UUID)
RETURNS INTEGER AS $$
DECLARE
  v_rule          schedule_rules%ROWTYPE;
  v_generate_from DATE;
  v_generate_until DATE;
  v_current_date  DATE;
  v_slot_start    TIME;
  v_slot_end      TIME;
  v_slot_count    INTEGER := 0;
  v_day_name      TEXT;
BEGIN
  -- Load the rule.
  SELECT * INTO v_rule FROM schedule_rules WHERE id = p_rule_id AND is_active = TRUE;
  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  -- Determine generation window.
  -- Start from: max(effective_from, last_generated_until + 1, today)
  v_generate_from := GREATEST(
    v_rule.effective_from,
    COALESCE(v_rule.last_generated_until + INTERVAL '1 day', CURRENT_DATE)::DATE,
    CURRENT_DATE
  );

  -- Generate up to 60 days from today.
  v_generate_until := LEAST(
    CURRENT_DATE + INTERVAL '60 days',
    COALESCE(v_rule.effective_until, CURRENT_DATE + INTERVAL '60 days')
  )::DATE;

  -- Nothing to generate.
  IF v_generate_from > v_generate_until THEN
    RETURN 0;
  END IF;

  -- Loop through each date in the range.
  v_current_date := v_generate_from;
  WHILE v_current_date <= v_generate_until LOOP

    -- Get the English day name in lowercase.
    v_day_name := LOWER(TO_CHAR(v_current_date, 'Day'));
    v_day_name := TRIM(v_day_name);

    -- Check if this day of week is in the rule's active_days array.
    IF v_day_name::day_of_week = ANY(v_rule.active_days) THEN

      -- Skip if this date is blocked for this doctor.
      IF NOT EXISTS (
        SELECT 1 FROM blocked_dates
        WHERE doctor_id = v_rule.doctor_id
          AND block_from <= v_current_date
          AND block_until >= v_current_date
          AND (clinic_id IS NULL OR clinic_id = v_rule.clinic_id)
      ) THEN

        -- Generate all slots for this day.
        v_slot_start := v_rule.start_time;

        WHILE v_slot_start < v_rule.end_time LOOP
          v_slot_end := v_slot_start + (v_rule.slot_duration_minutes || ' minutes')::INTERVAL;

          -- Don't create a slot that extends past end_time.
          IF v_slot_end > v_rule.end_time THEN
            EXIT;
          END IF;

          -- Insert the slot. Skip silently if it already exists.
          INSERT INTO time_slots (
            schedule_rule_id,
            doctor_id,
            clinic_id,
            slot_date,
            slot_start_time,
            slot_end_time,
            slot_start_at,
            slot_end_at,
            duration_minutes
          ) VALUES (
            v_rule.id,
            v_rule.doctor_id,
            v_rule.clinic_id,
            v_current_date,
            v_slot_start,
            v_slot_end,
            -- Combine date + time into TIMESTAMPTZ in IST.
            (v_current_date::TEXT || ' ' || v_slot_start::TEXT || '+05:30')::TIMESTAMPTZ,
            (v_current_date::TEXT || ' ' || v_slot_end::TEXT   || '+05:30')::TIMESTAMPTZ,
            v_rule.slot_duration_minutes
          )
          ON CONFLICT (doctor_id, clinic_id, slot_date, slot_start_time)
            DO NOTHING;

          v_slot_count := v_slot_count + 1;
          v_slot_start := v_slot_end;
        END LOOP;

      END IF;
    END IF;

    v_current_date := v_current_date + INTERVAL '1 day';
  END LOOP;

  -- Update the rule's last_generated_until marker.
  UPDATE schedule_rules
    SET last_generated_until = v_generate_until,
        updated_at = NOW()
  WHERE id = p_rule_id;

  RETURN v_slot_count;
END;
$$ LANGUAGE plpgsql;


-- ── FUNCTION: release_expired_locks() ────────────────────────
-- Releases slot locks that have been held for more than 5 minutes
-- without a confirmed booking. Called by a cron job every minute.
-- This is the safety net for abandoned checkouts.

CREATE OR REPLACE FUNCTION release_expired_locks()
RETURNS INTEGER AS $$
DECLARE
  v_released INTEGER;
BEGIN
  UPDATE time_slots
  SET
    is_locked  = FALSE,
    locked_at  = NULL,
    locked_by_session = NULL,
    status     = 'available',
    updated_at = NOW()
  WHERE
    is_locked = TRUE
    AND locked_at < NOW() - INTERVAL '5 minutes'
    AND status = 'available'  -- only release if not already booked
    AND booking_id IS NULL;

  GET DIAGNOSTICS v_released = ROW_COUNT;
  RETURN v_released;
END;
$$ LANGUAGE plpgsql;


-- ── FUNCTION: expire_past_slots() ────────────────────────────
-- Marks all available slots whose time has passed as 'expired'.
-- Called by a cron job every 15 minutes.
-- Expired slots are never shown to patients in search results.

CREATE OR REPLACE FUNCTION expire_past_slots()
RETURNS INTEGER AS $$
DECLARE
  v_expired INTEGER;
BEGIN
  UPDATE time_slots
  SET
    status     = 'expired',
    updated_at = NOW()
  WHERE
    status     = 'available'
    AND slot_start_at < NOW();

  GET DIAGNOSTICS v_expired = ROW_COUNT;
  RETURN v_expired;
END;
$$ LANGUAGE plpgsql;


-- ── FUNCTION: approve_schedule_request() ─────────────────────
-- Called when a doctor taps "Accept" on a schedule request.
-- Does three things atomically inside a transaction:
--   1. Updates schedule_request status to 'approved'
--   2. Deactivates any existing active rule for same doctor+clinic
--   3. Creates a new schedule_rule from the approved request
-- Everything happens in one transaction — all or nothing.

CREATE OR REPLACE FUNCTION approve_schedule_request(
  p_request_id UUID,
  p_doctor_user_id UUID  -- the user_id of the doctor approving
)
RETURNS UUID AS $$  -- returns the new schedule_rule id
DECLARE
  v_request   schedule_requests%ROWTYPE;
  v_new_rule_id UUID;
BEGIN
  -- Load the request and lock it for update (prevent race conditions).
  SELECT * INTO v_request
  FROM schedule_requests
  WHERE id = p_request_id AND status = 'pending'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Schedule request % not found or not pending', p_request_id;
  END IF;

  -- Deactivate any existing active rules for this doctor at this clinic.
  UPDATE schedule_rules
  SET
    is_active      = FALSE,
    deactivated_at = NOW(),
    deactivated_by = p_doctor_user_id,
    updated_at     = NOW()
  WHERE
    doctor_id = v_request.doctor_id
    AND clinic_id = v_request.clinic_id
    AND is_active = TRUE;

  -- Create the new schedule rule from the approved request.
  INSERT INTO schedule_rules (
    schedule_request_id,
    doctor_id,
    clinic_id,
    doctor_clinic_link_id,
    active_days,
    start_time,
    end_time,
    slot_duration_minutes,
    max_patients_per_day,
    effective_from,
    effective_until
  ) VALUES (
    v_request.id,
    v_request.doctor_id,
    v_request.clinic_id,
    v_request.doctor_clinic_link_id,
    v_request.proposed_days,
    v_request.proposed_start_time,
    v_request.proposed_end_time,
    v_request.slot_duration_minutes,
    v_request.max_patients_per_day,
    GREATEST(v_request.effective_from, CURRENT_DATE),
    v_request.effective_until
  )
  RETURNING id INTO v_new_rule_id;

  -- Update the request: mark approved and link to the new rule.
  UPDATE schedule_requests
  SET
    status           = 'approved',
    responded_at     = NOW(),
    resulting_rule_id = v_new_rule_id,
    updated_at       = NOW()
  WHERE id = p_request_id;

  -- Immediately generate slots for the next 60 days for the new rule.
  -- (The nightly job will keep this topped up.)
  PERFORM generate_slots_for_rule(v_new_rule_id);

  RETURN v_new_rule_id;
END;
$$ LANGUAGE plpgsql;


-- ── SCHEDULED JOB NOTES ───────────────────────────────────────
-- The following jobs must be configured in your job scheduler
-- (pg_cron, or an external scheduler like AWS EventBridge + Lambda).
--
-- Job 1: Nightly slot generation (runs at 00:30 IST daily)
--   SELECT generate_slots_for_rule(id)
--   FROM schedule_rules WHERE is_active = TRUE;
--
-- Job 2: Lock expiry (runs every minute)
--   SELECT release_expired_locks();
--
-- Job 3: Slot expiry (runs every 15 minutes)
--   SELECT expire_past_slots();
--
-- Job 4: Schedule request escalation (runs every hour)
--   -- Find pending requests > 48h with no reminder:
--   UPDATE schedule_requests SET reminder_sent_at = NOW()
--   WHERE status = 'pending'
--     AND reminder_sent_at IS NULL
--     AND created_at < NOW() - INTERVAL '48 hours';
--
--   -- Find pending requests > 72h: mark expired, notify clinic:
--   UPDATE schedule_requests SET status = 'expired', escalation_sent_at = NOW()
--   WHERE status = 'pending'
--     AND created_at < NOW() - INTERVAL '72 hours';


-- ============================================================
--  END OF PHASE 3: SCHEDULING ENGINE
--
--  Tables created:
--    schedule_requests   — clinic proposes schedule, doctor approves/rejects
--    schedule_rules      — approved recurring schedule (immutable once created)
--    time_slots          — individual bookable slots (generated nightly)
--    blocked_dates       — doctor date blocks (vacation, leave, etc.)
--
--  Functions created:
--    generate_slots_for_rule()      — generates 60 days of slots from a rule
--    release_expired_locks()        — releases abandoned checkout locks
--    expire_past_slots()            — marks past available slots as expired
--    approve_schedule_request()     — atomic approval + rule creation + slot gen
--
--  Key design decisions:
--    - schedule_rules are IMMUTABLE. Changes create new requests/rules.
--    - Slots generated 60 days rolling via nightly background job
--    - SELECT FOR UPDATE used for slot locking (prevents double booking)
--    - Slot lock TTL: 5 minutes (released by release_expired_locks job)
--    - blocked_dates triggers cascade slot update via background job
--    - approve_schedule_request() is fully atomic (all or nothing)
--    - Times always stored in IST (+05:30) — no timezone ambiguity
--    - UNIQUE constraint on (doctor_id, clinic_id, slot_date, slot_start_time)
--      prevents duplicate slots even if generator runs twice
--
--  Next: Phase 4 — Bookings
--        (bookings, cancellations, reschedules, audit_log)
-- ============================================================
