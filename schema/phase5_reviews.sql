-- ============================================================
--  MEDBOOK INDIA — DATABASE SCHEMA
--  Phase 5: Reviews & Ratings, Notifications Log, Payments
--  Depends on: Phase 1–4 (all previous phases)
--  Database: PostgreSQL 15+
--  Version: 1.0 — April 2026
-- ============================================================


-- ══════════════════════════════════════════════════════════════
--  SECTION A: REVIEWS & RATINGS
-- ══════════════════════════════════════════════════════════════

-- ── ENUMS ────────────────────────────────────────────────────

-- Review moderation states.
CREATE TYPE review_status AS ENUM (
  'pending',      -- newly submitted, not yet shown publicly (brief auto-check)
  'published',    -- visible on doctor profile
  'flagged',      -- reported by doctor or clinic, under admin review
  'removed'       -- removed by admin for policy violation
);


-- ── TABLE: reviews ────────────────────────────────────────────
-- Patient reviews of doctors after a completed appointment.
--
-- Key rules enforced here:
--   1. One review per booking (UNIQUE on booking_id)
--   2. Only patients who completed an appointment can review
--      (enforced by FK to bookings + app-layer status check)
--   3. Rating must be 1–5 (CHECK constraint)
--   4. Doctor avg_rating is recomputed by trigger on every insert/update
--
-- Design decision: We store ratings as SMALLINT (1–5), not decimal.
-- Patients give whole star ratings. We compute the average in the DB.
-- The computed average on doctor_profiles is NUMERIC(3,2) for display.

CREATE TABLE reviews (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- The booking this review is for.
  -- One review per booking — enforced by UNIQUE.
  booking_id        UUID NOT NULL UNIQUE REFERENCES bookings(id)
                      ON DELETE RESTRICT,

  -- Denormalised for fast queries without multiple joins.
  patient_id        UUID NOT NULL REFERENCES patient_profiles(id)
                      ON DELETE RESTRICT,
  doctor_id         UUID NOT NULL REFERENCES doctor_profiles(id)
                      ON DELETE RESTRICT,
  clinic_id         UUID NOT NULL REFERENCES clinic_profiles(id)
                      ON DELETE RESTRICT,

  -- The star rating: 1, 2, 3, 4, or 5. Nothing else.
  rating            SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),

  -- Optional written review. 1000 character limit.
  review_text       TEXT CHECK (char_length(review_text) <= 1000),

  -- Specific sub-ratings (optional, for richer feedback in Phase 2).
  -- Stored as JSONB so we can add/remove sub-categories without schema changes.
  -- Example: {
  --   "wait_time": 4,
  --   "doctor_communication": 5,
  --   "clinic_cleanliness": 3
  -- }
  sub_ratings       JSONB DEFAULT '{}',

  -- Moderation state.
  status            review_status NOT NULL DEFAULT 'pending',

  -- When admin reviewed/moderated this review.
  moderated_at      TIMESTAMPTZ,
  moderated_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  moderation_note   TEXT,   -- internal note if removed/flagged

  -- Doctor's public reply to the review (optional).
  doctor_reply      TEXT CHECK (char_length(doctor_reply) <= 500),
  doctor_replied_at TIMESTAMPTZ,

  -- Was this review submitted via the WhatsApp prompt or in-app?
  submitted_via     VARCHAR(20) DEFAULT 'whatsapp',
  -- 'whatsapp' | 'in_app'

  -- The appointment date (denormalised for display "Review from April 2026").
  appointment_date  DATE NOT NULL,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for reviews.
-- Most common: all published reviews for a doctor (profile page).
CREATE INDEX idx_reviews_doctor_published ON reviews (doctor_id, created_at DESC)
  WHERE status = 'published';

-- Patient's review history.
CREATE INDEX idx_reviews_patient          ON reviews (patient_id, created_at DESC);

-- Admin moderation queue.
CREATE INDEX idx_reviews_pending          ON reviews (status, created_at)
  WHERE status IN ('pending', 'flagged');

-- Clinic reviews (show all reviews for doctors at this clinic).
CREATE INDEX idx_reviews_clinic           ON reviews (clinic_id, created_at DESC)
  WHERE status = 'published';

CREATE TRIGGER set_reviews_updated_at
  BEFORE UPDATE ON reviews
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();


-- ── FK: bookings → reviews ────────────────────────────────────
-- Now that reviews table exists, add the FK from bookings.
ALTER TABLE bookings
  ADD CONSTRAINT fk_bookings_review
  FOREIGN KEY (review_id) REFERENCES reviews(id)
  ON DELETE SET NULL;


-- ── FUNCTION: update_doctor_rating() ─────────────────────────
-- Triggered after every INSERT or UPDATE on reviews.
-- Recomputes the doctor's avg_rating and total_reviews count
-- directly from the published reviews in the reviews table.
--
-- Design decision: We recompute from source rather than
-- incrementally updating. This is slightly slower but 100% accurate.
-- At Phase 1 scale (hundreds of reviews per doctor) this is fine.
-- At massive scale (millions), switch to incremental updates.

CREATE OR REPLACE FUNCTION update_doctor_rating()
RETURNS TRIGGER AS $$
DECLARE
  v_doctor_id   UUID;
  v_avg_rating  NUMERIC(3,2);
  v_total       INTEGER;
BEGIN
  -- Determine which doctor to update.
  -- Works for both INSERT (NEW) and UPDATE (NEW or OLD may differ).
  v_doctor_id := COALESCE(NEW.doctor_id, OLD.doctor_id);

  -- Recompute from published reviews only.
  SELECT
    COALESCE(ROUND(AVG(rating)::NUMERIC, 2), 0.00),
    COUNT(*)
  INTO v_avg_rating, v_total
  FROM reviews
  WHERE doctor_id = v_doctor_id
    AND status = 'published';

  -- Update the doctor profile.
  UPDATE doctor_profiles
  SET
    avg_rating     = v_avg_rating,
    total_reviews  = v_total,
    updated_at     = NOW()
  WHERE id = v_doctor_id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply trigger: fires after any review insert or update.
CREATE TRIGGER trg_update_doctor_rating
  AFTER INSERT OR UPDATE ON reviews
  FOR EACH ROW EXECUTE FUNCTION update_doctor_rating();


-- ── FUNCTION: submit_review() ─────────────────────────────────
-- Called when a patient submits a review.
-- Validates the booking is completed and belongs to this patient.
-- Creates the review and links it back to the booking.

CREATE OR REPLACE FUNCTION submit_review(
  p_booking_id    UUID,
  p_patient_user_id UUID,
  p_rating        SMALLINT,
  p_review_text   TEXT DEFAULT NULL,
  p_sub_ratings   JSONB DEFAULT '{}',
  p_submitted_via VARCHAR DEFAULT 'whatsapp'
)
RETURNS UUID AS $$
DECLARE
  v_booking     bookings%ROWTYPE;
  v_patient     patient_profiles%ROWTYPE;
  v_review_id   UUID;
BEGIN
  -- Load the booking.
  SELECT * INTO v_booking
  FROM bookings
  WHERE id = p_booking_id AND status = 'completed';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Booking % not found or not completed', p_booking_id;
  END IF;

  -- Verify the patient submitting is the one who made the booking.
  SELECT * INTO v_patient
  FROM patient_profiles
  WHERE id = v_booking.patient_id
    AND user_id = p_patient_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Patient does not own this booking';
  END IF;

  -- Check no review already exists for this booking.
  IF v_booking.review_id IS NOT NULL THEN
    RAISE EXCEPTION 'A review already exists for booking %', p_booking_id;
  END IF;

  -- Create the review.
  -- Status starts as 'pending' for a brief auto-moderation check.
  -- A background job promotes it to 'published' within 60 seconds
  -- unless flagged by the auto-moderation rules.
  INSERT INTO reviews (
    booking_id,
    patient_id,
    doctor_id,
    clinic_id,
    rating,
    review_text,
    sub_ratings,
    submitted_via,
    appointment_date
  ) VALUES (
    p_booking_id,
    v_booking.patient_id,
    v_booking.doctor_id,
    v_booking.clinic_id,
    p_rating,
    p_review_text,
    p_sub_ratings,
    p_submitted_via,
    v_booking.appointment_date
  )
  RETURNING id INTO v_review_id;

  -- Link review back to booking.
  UPDATE bookings
  SET review_id = v_review_id, updated_at = NOW()
  WHERE id = p_booking_id;

  RETURN v_review_id;
END;
$$ LANGUAGE plpgsql;


-- ══════════════════════════════════════════════════════════════
--  SECTION B: NOTIFICATIONS LOG
-- ══════════════════════════════════════════════════════════════

-- ── ENUMS ────────────────────────────────────────────────────

-- Which channel was used to send this notification.
CREATE TYPE notification_channel AS ENUM (
  'whatsapp',     -- WhatsApp Business API (primary)
  'sms',          -- MSG91 SMS (fallback)
  'push',         -- Firebase Cloud Messaging (in-app push)
  'email'         -- Email (admin/clinic only, rare)
);

-- Delivery status reported back by the provider.
CREATE TYPE notification_delivery_status AS ENUM (
  'queued',       -- in our outbox, not yet sent to provider
  'sent',         -- handed off to provider (WhatsApp/MSG91/FCM)
  'delivered',    -- provider confirmed delivery to device
  'read',         -- recipient opened/read it (WhatsApp read receipts)
  'failed',       -- provider reported delivery failure
  'bounced'       -- invalid number or device (SMS/email)
);

-- What type of notification is this.
CREATE TYPE notification_type AS ENUM (
  'booking_confirmation',
  'booking_reminder_24h',
  'booking_reminder_2h',
  'booking_cancelled',
  'booking_rescheduled',
  'reschedule_offer',        -- clinic/doctor offering patient a new slot
  'review_request',
  'schedule_request',        -- clinic → doctor: new schedule request
  'schedule_reminder',       -- 48h reminder to doctor
  'schedule_approved',       -- doctor approved → clinic notified
  'schedule_rejected',       -- doctor rejected → clinic notified
  'link_request',            -- clinic → doctor: link request
  'link_accepted',
  'link_rejected',
  'verification_approved',   -- admin → doctor/clinic: profile approved
  'verification_rejected',   -- admin → doctor/clinic: profile rejected
  'daily_schedule_summary',  -- morning WhatsApp to doctor
  'flag_raised',             -- admin → clinic: cancellation flagged
  'general'                  -- catch-all for system messages
);


-- ── TABLE: notification_log ───────────────────────────────────
-- Every notification sent by the platform is logged here.
-- This is your audit trail for "we did send that reminder".
-- Also used for debugging provider failures and retry logic.
--
-- Design decision: This table will grow very large very fast.
-- In production, partition by month:
--   PARTITION BY RANGE (created_at)
-- For Phase 1 at Bengaluru scale, a single table with good
-- indexes is sufficient.

CREATE TABLE notification_log (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Who received this notification.
  recipient_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- The recipient's phone/email at time of sending (denormalised).
  -- We store it here because users can change their contact details.
  recipient_phone   VARCHAR(15),
  recipient_email   VARCHAR(255),
  recipient_fcm_token TEXT,

  -- What type of notification.
  notification_type notification_type NOT NULL,

  -- Which channel was used.
  channel           notification_channel NOT NULL,

  -- Delivery status (updated by webhook from provider).
  delivery_status   notification_delivery_status NOT NULL DEFAULT 'queued',

  -- The template name used (e.g., 'booking_confirmed_hi' for Hindi).
  -- Stored for debugging which template version was used.
  template_name     VARCHAR(100),

  -- The actual message content sent (for audit purposes).
  -- Truncated to 1000 chars to save space.
  message_content   TEXT,

  -- The data variables injected into the template.
  -- Example: {"doctor_name": "Dr. Ramesh", "time": "9:30 AM", "date": "14 Apr"}
  template_variables JSONB DEFAULT '{}',

  -- Provider-specific message ID (for tracking delivery on their dashboard).
  -- WhatsApp: message SID
  -- MSG91: requestId
  -- FCM: message_id
  provider_message_id VARCHAR(255),

  -- Provider response (raw, for debugging).
  provider_response JSONB DEFAULT '{}',

  -- Related entities (for filtering "all notifications for booking X").
  related_booking_id    UUID REFERENCES bookings(id) ON DELETE SET NULL,
  related_doctor_id     UUID REFERENCES doctor_profiles(id) ON DELETE SET NULL,
  related_clinic_id     UUID REFERENCES clinic_profiles(id) ON DELETE SET NULL,

  -- Retry tracking.
  retry_count       SMALLINT NOT NULL DEFAULT 0,
  last_retry_at     TIMESTAMPTZ,
  next_retry_at     TIMESTAMPTZ,   -- NULL if no retry needed

  -- When the notification was actually sent to the provider.
  sent_at           TIMESTAMPTZ,

  -- When delivery was confirmed by provider webhook.
  delivered_at      TIMESTAMPTZ,

  -- When the message was read (WhatsApp read receipt).
  read_at           TIMESTAMPTZ,

  -- When provider reported failure.
  failed_at         TIMESTAMPTZ,
  failure_reason    TEXT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()

  -- No updated_at: we append status updates via UPDATE, but no trigger needed.
  -- Delivery status is updated by webhook handler — low frequency.
);

-- Indexes for notification_log.
-- Most common: find all notifications for a specific booking.
CREATE INDEX idx_notif_booking_id    ON notification_log (related_booking_id)
  WHERE related_booking_id IS NOT NULL;

-- Find all notifications for a user (for support: "show me all messages sent to X").
CREATE INDEX idx_notif_recipient     ON notification_log (recipient_user_id, created_at DESC);

-- Retry job: find queued/failed notifications that need retry.
CREATE INDEX idx_notif_retry         ON notification_log (next_retry_at, delivery_status)
  WHERE next_retry_at IS NOT NULL
    AND delivery_status IN ('queued', 'failed');

-- Delivery status monitoring.
CREATE INDEX idx_notif_status        ON notification_log (delivery_status, created_at);

-- Provider message ID lookup (for processing incoming webhooks).
CREATE INDEX idx_notif_provider_id   ON notification_log (provider_message_id)
  WHERE provider_message_id IS NOT NULL;

-- Type + date for analytics (e.g., how many reminders sent this week).
CREATE INDEX idx_notif_type_date     ON notification_log (notification_type, created_at);


-- ── FUNCTION: log_notification() ─────────────────────────────
-- Helper function to create a notification log entry.
-- Called by the notification service (application layer) before
-- handing off to the provider API.
-- Returns the notification log ID for tracking.

CREATE OR REPLACE FUNCTION log_notification(
  p_recipient_user_id   UUID,
  p_notification_type   notification_type,
  p_channel             notification_channel,
  p_template_name       VARCHAR,
  p_template_variables  JSONB DEFAULT '{}',
  p_related_booking_id  UUID DEFAULT NULL,
  p_related_doctor_id   UUID DEFAULT NULL,
  p_related_clinic_id   UUID DEFAULT NULL
)
RETURNS UUID AS $$
DECLARE
  v_user          users%ROWTYPE;
  v_log_id        UUID;
BEGIN
  -- Load recipient contact details.
  SELECT * INTO v_user FROM users WHERE id = p_recipient_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'User % not found for notification', p_recipient_user_id;
  END IF;

  INSERT INTO notification_log (
    recipient_user_id,
    recipient_phone,
    recipient_fcm_token,
    notification_type,
    channel,
    template_name,
    template_variables,
    related_booking_id,
    related_doctor_id,
    related_clinic_id,
    delivery_status
  ) VALUES (
    p_recipient_user_id,
    v_user.phone,
    v_user.fcm_token,
    p_notification_type,
    p_channel,
    p_template_name,
    p_template_variables,
    p_related_booking_id,
    p_related_doctor_id,
    p_related_clinic_id,
    'queued'
  )
  RETURNING id INTO v_log_id;

  RETURN v_log_id;
END;
$$ LANGUAGE plpgsql;


-- ══════════════════════════════════════════════════════════════
--  SECTION C: PAYMENTS
-- ══════════════════════════════════════════════════════════════
-- Phase 1: Mostly "Pay at Clinic". Schema designed to support
-- Phase 2 online UPI payments without any structural changes.

-- ── ENUMS ────────────────────────────────────────────────────

-- Which payment gateway processed this transaction.
CREATE TYPE payment_gateway AS ENUM (
  'none',       -- pay_at_clinic (no gateway involved)
  'razorpay',   -- Razorpay (Phase 2 primary gateway)
  'phonepe',    -- PhonePe Business (alternative)
  'paytm'       -- Paytm Business (alternative)
);

-- Type of payment transaction.
CREATE TYPE payment_transaction_type AS ENUM (
  'charge',     -- initial payment from patient
  'refund',     -- money returned to patient
  'partial_refund'  -- partial amount returned
);


-- ── TABLE: payments ───────────────────────────────────────────
-- One payment record per booking.
-- For Phase 1 pay_at_clinic bookings:
--   - gateway = 'none'
--   - status = 'not_applicable'
--   - All gateway fields are NULL
--
-- For Phase 2 online UPI payments:
--   - gateway = 'razorpay'
--   - status transitions: pending → paid → (refunded if cancelled)
--   - Gateway fields populated from Razorpay webhooks
--
-- Design decision: We keep a separate payments table rather than
-- storing payment fields on bookings. Reasons:
--   1. A booking can have multiple transactions (charge + refund)
--   2. Payment data is sensitive — isolation makes access control easier
--   3. Gateway-specific fields vary — JSONB handles this cleanly

CREATE TABLE payments (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- The booking this payment is for.
  booking_id            UUID NOT NULL REFERENCES bookings(id)
                          ON DELETE RESTRICT,

  -- Patient who made the payment.
  patient_id            UUID NOT NULL REFERENCES patient_profiles(id)
                          ON DELETE RESTRICT,

  -- Type of transaction.
  transaction_type      payment_transaction_type NOT NULL DEFAULT 'charge',

  -- If this is a refund, which original payment are we refunding?
  refund_of_payment_id  UUID REFERENCES payments(id) ON DELETE SET NULL,

  -- Amount in paise (e.g., ₹800 = 80000).
  amount_paise          INTEGER NOT NULL CHECK (amount_paise >= 0),

  -- Payment method used.
  payment_method        payment_method NOT NULL DEFAULT 'pay_at_clinic',

  -- Payment status.
  payment_status        payment_status NOT NULL DEFAULT 'not_applicable',

  -- Which gateway processed this.
  gateway               payment_gateway NOT NULL DEFAULT 'none',

  -- ── Gateway-Specific Fields ────────────────────────────────
  -- Razorpay order ID (created when patient initiates payment).
  gateway_order_id      VARCHAR(255),

  -- Razorpay payment ID (received after successful payment).
  gateway_payment_id    VARCHAR(255) UNIQUE,

  -- Razorpay refund ID (if refunded).
  gateway_refund_id     VARCHAR(255),

  -- Raw gateway response stored for debugging and reconciliation.
  -- Contains full Razorpay webhook payload.
  gateway_response      JSONB DEFAULT '{}',

  -- UPI transaction reference (VPA used by patient).
  upi_transaction_ref   VARCHAR(255),
  upi_vpa               VARCHAR(255),  -- e.g. 'priya@okaxis'

  -- ── Timing ────────────────────────────────────────────────
  -- When payment was initiated by patient.
  payment_initiated_at  TIMESTAMPTZ,

  -- When payment was confirmed by gateway webhook.
  payment_confirmed_at  TIMESTAMPTZ,

  -- When refund was initiated.
  refund_initiated_at   TIMESTAMPTZ,

  -- When refund was confirmed by gateway.
  refund_confirmed_at   TIMESTAMPTZ,

  -- ── Failure Handling ──────────────────────────────────────
  failure_code          VARCHAR(100),   -- gateway error code
  failure_description   TEXT,           -- human-readable failure reason

  -- Retry count for failed payments.
  retry_count           SMALLINT NOT NULL DEFAULT 0,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for payments.
CREATE INDEX idx_payments_booking_id      ON payments (booking_id);
CREATE INDEX idx_payments_patient_id      ON payments (patient_id);
CREATE INDEX idx_payments_gateway_order   ON payments (gateway_order_id)
  WHERE gateway_order_id IS NOT NULL;
CREATE INDEX idx_payments_gateway_payment ON payments (gateway_payment_id)
  WHERE gateway_payment_id IS NOT NULL;
CREATE INDEX idx_payments_status          ON payments (payment_status, created_at);

-- Refund tracking.
CREATE INDEX idx_payments_refund_of       ON payments (refund_of_payment_id)
  WHERE refund_of_payment_id IS NOT NULL;

CREATE TRIGGER set_payments_updated_at
  BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();


-- ── FUNCTION: initiate_payment() ─────────────────────────────
-- Called when a patient selects "Pay Now" (Phase 2).
-- Creates a payment record in 'pending' state.
-- Application layer then calls Razorpay API with the returned ID.

CREATE OR REPLACE FUNCTION initiate_payment(
  p_booking_id      UUID,
  p_payment_method  payment_method,
  p_gateway         payment_gateway
)
RETURNS UUID AS $$
DECLARE
  v_booking     bookings%ROWTYPE;
  v_payment_id  UUID;
BEGIN
  SELECT * INTO v_booking
  FROM bookings
  WHERE id = p_booking_id AND status IN ('initiated', 'confirmed');

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Booking % not found or invalid status', p_booking_id;
  END IF;

  -- For pay_at_clinic, no gateway payment needed.
  IF p_payment_method = 'pay_at_clinic' THEN
    INSERT INTO payments (
      booking_id, patient_id, transaction_type,
      amount_paise, payment_method, payment_status, gateway,
      payment_initiated_at
    ) VALUES (
      p_booking_id, v_booking.patient_id, 'charge',
      v_booking.fee_paise, 'pay_at_clinic', 'not_applicable', 'none',
      NOW()
    ) RETURNING id INTO v_payment_id;
    RETURN v_payment_id;
  END IF;

  -- For online payments: create pending record.
  INSERT INTO payments (
    booking_id, patient_id, transaction_type,
    amount_paise, payment_method, payment_status, gateway,
    payment_initiated_at
  ) VALUES (
    p_booking_id, v_booking.patient_id, 'charge',
    v_booking.fee_paise, p_payment_method, 'pending', p_gateway,
    NOW()
  ) RETURNING id INTO v_payment_id;

  -- Update booking payment status.
  UPDATE bookings
  SET payment_status = 'pending', updated_at = NOW()
  WHERE id = p_booking_id;

  RETURN v_payment_id;
END;
$$ LANGUAGE plpgsql;


-- ── FUNCTION: confirm_payment() ───────────────────────────────
-- Called by the Razorpay webhook handler when payment succeeds.
-- Updates payment status and booking payment status atomically.

CREATE OR REPLACE FUNCTION confirm_payment(
  p_payment_id          UUID,
  p_gateway_payment_id  VARCHAR,
  p_gateway_response    JSONB DEFAULT '{}'
)
RETURNS BOOLEAN AS $$
BEGIN
  UPDATE payments
  SET
    payment_status       = 'paid',
    gateway_payment_id   = p_gateway_payment_id,
    gateway_response     = p_gateway_response,
    payment_confirmed_at = NOW(),
    updated_at           = NOW()
  WHERE id = p_payment_id AND payment_status = 'pending';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment % not found or not pending', p_payment_id;
  END IF;

  -- Sync status back to booking.
  UPDATE bookings
  SET
    payment_status        = 'paid',
    payment_confirmed_at  = NOW(),
    payment_gateway_ref   = p_gateway_payment_id,
    updated_at            = NOW()
  WHERE id = (SELECT booking_id FROM payments WHERE id = p_payment_id);

  RETURN TRUE;
END;
$$ LANGUAGE plpgsql;


-- ── FUNCTION: refund_payment() ────────────────────────────────
-- Called when a booking is cancelled and a refund is due.
-- Creates a refund transaction record.
-- Application layer calls Razorpay refund API with the returned refund record ID.

CREATE OR REPLACE FUNCTION refund_payment(
  p_original_payment_id UUID,
  p_refund_amount_paise INTEGER,
  p_gateway_refund_id   VARCHAR DEFAULT NULL
)
RETURNS UUID AS $$
DECLARE
  v_original    payments%ROWTYPE;
  v_refund_id   UUID;
  v_is_partial  BOOLEAN;
BEGIN
  SELECT * INTO v_original
  FROM payments
  WHERE id = p_original_payment_id AND payment_status = 'paid';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Original payment % not found or not paid', p_original_payment_id;
  END IF;

  -- Determine if this is a full or partial refund.
  v_is_partial := p_refund_amount_paise < v_original.amount_paise;

  -- Create refund transaction.
  INSERT INTO payments (
    booking_id,
    patient_id,
    transaction_type,
    refund_of_payment_id,
    amount_paise,
    payment_method,
    payment_status,
    gateway,
    gateway_refund_id,
    refund_initiated_at,
    refund_confirmed_at
  ) VALUES (
    v_original.booking_id,
    v_original.patient_id,
    CASE WHEN v_is_partial THEN 'partial_refund' ELSE 'refund' END,
    p_original_payment_id,
    p_refund_amount_paise,
    v_original.payment_method,
    'refunded',
    v_original.gateway,
    p_gateway_refund_id,
    NOW(),
    CASE WHEN p_gateway_refund_id IS NOT NULL THEN NOW() ELSE NULL END
  )
  RETURNING id INTO v_refund_id;

  -- Update original payment status.
  UPDATE payments
  SET
    payment_status      = 'refunded',
    gateway_refund_id   = p_gateway_refund_id,
    refund_initiated_at = NOW(),
    updated_at          = NOW()
  WHERE id = p_original_payment_id;

  -- Update booking payment status.
  UPDATE bookings
  SET payment_status = 'refunded', updated_at = NOW()
  WHERE id = v_original.booking_id;

  RETURN v_refund_id;
END;
$$ LANGUAGE plpgsql;


-- ══════════════════════════════════════════════════════════════
--  SECTION D: PLATFORM ANALYTICS VIEWS
-- ══════════════════════════════════════════════════════════════
-- Lightweight views for the admin dashboard and clinic dashboards.
-- These are regular views for Phase 1.
-- In Phase 2, convert to MATERIALISED VIEWS with scheduled refresh.

-- ── VIEW: daily_booking_stats ────────────────────────────────
-- Daily snapshot of bookings across the platform.
-- Admin dashboard: how many bookings happened today / this week.

CREATE VIEW daily_booking_stats AS
SELECT
  DATE(appointment_date)          AS stat_date,
  COUNT(*)                        AS total_bookings,
  COUNT(*) FILTER (WHERE status = 'confirmed')   AS confirmed,
  COUNT(*) FILTER (WHERE status = 'completed')   AS completed,
  COUNT(*) FILTER (WHERE status = 'cancelled')   AS cancelled,
  COUNT(*) FILTER (WHERE status = 'no_show')     AS no_shows,
  COUNT(*) FILTER (WHERE status = 'rescheduled') AS rescheduled,
  COUNT(*) FILTER (WHERE is_flagged = TRUE)       AS flagged,
  SUM(fee_paise) FILTER (WHERE status IN ('confirmed','completed')) / 100.0 AS total_fee_inr
FROM bookings
GROUP BY DATE(appointment_date)
ORDER BY stat_date DESC;


-- ── VIEW: clinic_daily_queue_view ─────────────────────────────
-- Used by the clinic app for "Today's Queue" screen.
-- Shows all appointments for a clinic today with full context.

CREATE VIEW clinic_daily_queue_view AS
SELECT
  b.id                  AS booking_id,
  b.booking_reference,
  b.clinic_id,
  b.doctor_id,
  u_patient.full_name   AS patient_name,
  u_patient.phone       AS patient_phone,
  u_doctor.full_name    AS doctor_name,
  dp.primary_specialty,
  b.appointment_start_at,
  b.appointment_end_at,
  b.status,
  b.reason_for_visit,
  b.payment_method,
  b.payment_status,
  b.fee_paise / 100.0   AS fee_inr,
  b.is_flagged,
  -- Queue position for today (ordered by appointment time).
  ROW_NUMBER() OVER (
    PARTITION BY b.clinic_id, b.appointment_date
    ORDER BY b.appointment_start_at
  )                     AS queue_position
FROM bookings b
JOIN patient_profiles pp  ON pp.id = b.patient_id
JOIN users u_patient      ON u_patient.id = pp.user_id
JOIN doctor_profiles dp   ON dp.id = b.doctor_id
JOIN users u_doctor       ON u_doctor.id = dp.user_id
WHERE b.appointment_date = CURRENT_DATE
  AND b.status IN ('confirmed', 'completed', 'no_show');


-- ── VIEW: doctor_availability_view ───────────────────────────
-- Used by the patient app to show a doctor's upcoming available slots.
-- Groups slots by clinic location for the doctor profile screen.

CREATE VIEW doctor_availability_view AS
SELECT
  ts.doctor_id,
  ts.clinic_id,
  cp.name               AS clinic_name,
  cp.address_line1,
  cp.neighbourhood,
  cp.city,
  cp.latitude,
  cp.longitude,
  sr.active_days,
  sr.start_time         AS schedule_start,
  sr.end_time           AS schedule_end,
  sr.slot_duration_minutes,
  ts.slot_date,
  ts.slot_start_time,
  ts.slot_end_time,
  ts.slot_start_at,
  ts.id                 AS slot_id,
  ts.status             AS slot_status,
  ts.duration_minutes
FROM time_slots ts
JOIN schedule_rules sr    ON sr.id = ts.schedule_rule_id
JOIN clinic_profiles cp   ON cp.id = ts.clinic_id
WHERE ts.status    = 'available'
  AND ts.slot_date >= CURRENT_DATE
  AND ts.slot_date <= CURRENT_DATE + INTERVAL '60 days'
  AND cp.is_visible = TRUE
ORDER BY ts.slot_date, ts.slot_start_time;


-- ── VIEW: platform_summary_view ──────────────────────────────
-- Single-row summary for the admin home dashboard.

CREATE VIEW platform_summary_view AS
SELECT
  (SELECT COUNT(*) FROM doctor_profiles WHERE is_visible = TRUE)          AS active_doctors,
  (SELECT COUNT(*) FROM clinic_profiles WHERE is_visible = TRUE)           AS active_clinics,
  (SELECT COUNT(*) FROM users WHERE role = 'patient')                      AS total_patients,
  (SELECT COUNT(*) FROM bookings WHERE appointment_date = CURRENT_DATE)    AS bookings_today,
  (SELECT COUNT(*) FROM bookings WHERE status = 'confirmed'
     AND appointment_date = CURRENT_DATE)                                  AS confirmed_today,
  (SELECT COUNT(*) FROM doctor_profiles
     WHERE verification_status = 'submitted')                              AS pending_doctor_verifications,
  (SELECT COUNT(*) FROM clinic_profiles
     WHERE verification_status = 'submitted')                              AS pending_clinic_verifications,
  (SELECT COUNT(*) FROM schedule_requests WHERE status = 'pending')        AS pending_schedule_approvals,
  (SELECT COUNT(*) FROM bookings WHERE is_flagged = TRUE
     AND flag_resolved_at IS NULL)                                         AS unresolved_flags,
  (SELECT COUNT(*) FROM reviews WHERE status = 'pending')                  AS reviews_pending_moderation;


-- ============================================================
--  END OF PHASE 5: REVIEWS, NOTIFICATIONS & PAYMENTS
--
--  Tables created:
--    reviews               — patient reviews after completed appointments
--    notification_log      — every notification sent, with delivery status
--    payments              — payment transactions (charge + refund)
--
--  Functions created:
--    update_doctor_rating()  — trigger: recomputes avg_rating on review change
--    submit_review()         — validates + creates review, links to booking
--    log_notification()      — creates notification log entry before sending
--    initiate_payment()      — creates pending payment record
--    confirm_payment()       — marks payment paid on gateway webhook
--    refund_payment()        — creates refund transaction record
--
--  Views created:
--    daily_booking_stats         — platform-wide daily booking analytics
--    clinic_daily_queue_view     — clinic app Today's Queue screen
--    doctor_availability_view    — patient app doctor profile slot display
--    platform_summary_view       — admin dashboard one-row summary
--
--  Enums created:
--    review_status               — pending | published | flagged | removed
--    notification_channel        — whatsapp | sms | push | email
--    notification_delivery_status — queued | sent | delivered | read | failed | bounced
--    notification_type           — 19 types covering all platform events
--    payment_gateway             — none | razorpay | phonepe | paytm
--    payment_transaction_type    — charge | refund | partial_refund
--
--  Key design decisions:
--    - avg_rating recomputed by DB trigger — always accurate, no app bugs
--    - Reviews start as 'pending' — auto-promoted to 'published' in 60s
--    - Notification log is the proof of delivery for every message
--    - Payments table supports charge + refund as separate transaction rows
--    - All gateway fields are nullable — clean for pay_at_clinic Phase 1
--    - Platform analytics views are query-time for Phase 1
--      → convert to MATERIALISED VIEWS when traffic demands it
--
-- ============================================================
--
--  ████████████████████████████████████████████████████████
--  FULL SCHEMA COMPLETE — ALL 5 PHASES
--  ████████████████████████████████████████████████████████
--
--  COMPLETE TABLE LIST:
--  Phase 1 — Auth & Users
--    users, otp_verifications, user_sessions, patient_profiles
--
--  Phase 2 — Profiles
--    doctor_profiles, clinic_profiles, clinic_admins,
--    doctor_clinic_links, saved_doctors
--
--  Phase 3 — Scheduling
--    schedule_requests, schedule_rules, time_slots, blocked_dates
--
--  Phase 4 — Bookings
--    bookings, cancellations, booking_audit_log
--
--  Phase 5 — Reviews, Notifications, Payments
--    reviews, notification_log, payments
--
--  TOTAL: 18 tables, 27 functions/triggers, 5 views
--  Database: PostgreSQL 15+
--  Target: AWS RDS ap-south-1 (Mumbai) or GCP Cloud SQL Mumbai
-- ============================================================
