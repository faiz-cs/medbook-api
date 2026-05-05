// src/modules/notification/notification.service.ts
// ============================================================
//  Notification Service
//  WhatsApp (Gupshup), SMS (MSG91), Push (FCM)
//  Every notification is logged before sending
// ============================================================

import { query } from '../../config/database';
import { config } from '../../config/env';
import { logger } from '../../config/logger';

// ── Types ─────────────────────────────────────────────────────

type NotificationChannel = 'whatsapp' | 'sms' | 'push' | 'email';

interface SendResult {
  success:          boolean;
  providerMessageId: string | null;
  channel:          NotificationChannel;
}

// ── MSG91 SMS ─────────────────────────────────────────────────

async function sendSms(phone: string, message: string, templateId?: string): Promise<SendResult> {
  if (config.app.isDev) {
    logger.info(`📱 SMS to ${phone.slice(0,7)}****: ${message.slice(0, 60)}...`);
    return { success: true, providerMessageId: 'dev_sms', channel: 'sms' };
  }

  try {
    const response = await fetch('https://api.msg91.com/api/v5/flow/', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', authkey: config.msg91.apiKey },
      body: JSON.stringify({
        template_id: templateId || config.msg91.templateId,
        sender:      config.msg91.senderId,
        mobiles:     phone.replace('+', ''),
        VAR1:        message,
      }),
    });
    const data = await response.json() as { request_id?: string; message?: string };
    return {
      success:           response.ok,
      providerMessageId: data.request_id || null,
      channel:           'sms',
    };
  } catch (err) {
    logger.error('MSG91 SMS failed', { phone: phone.slice(0,7), err });
    return { success: false, providerMessageId: null, channel: 'sms' };
  }
}

// ── Gupshup WhatsApp ──────────────────────────────────────────

async function sendWhatsApp(phone: string, message: string, templateName?: string): Promise<SendResult> {
  if (config.app.isDev) {
    logger.info(`💬 WhatsApp to ${phone.slice(0,7)}****: ${message.slice(0, 80)}...`);
    return { success: true, providerMessageId: 'dev_wa', channel: 'whatsapp' };
  }

  try {
    const response = await fetch('https://api.gupshup.io/sm/api/v1/msg', {
      method:  'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        apikey:          config.gupshup.apiKey,
      },
      body: new URLSearchParams({
        channel:        'whatsapp',
        source:         config.gupshup.sourceNumber,
        destination:    phone,
        'src.name':     config.gupshup.appName,
        message:        JSON.stringify({ type: 'text', text: message }),
      }),
    });
    const data = await response.json() as { messageId?: string };
    return {
      success:           response.ok,
      providerMessageId: data.messageId || null,
      channel:           'whatsapp',
    };
  } catch (err) {
    logger.error('Gupshup WhatsApp failed', { phone: phone.slice(0,7), err });
    return { success: false, providerMessageId: null, channel: 'whatsapp' };
  }
}

// ── FCM Push ──────────────────────────────────────────────────

async function sendPush(fcmToken: string, title: string, body: string, data?: Record<string, string>): Promise<SendResult> {
  if (config.app.isDev) {
    logger.info(`🔔 Push: ${title} — ${body.slice(0, 60)}`);
    return { success: true, providerMessageId: 'dev_push', channel: 'push' };
  }

  if (!config.firebase.projectId) {
    return { success: false, providerMessageId: null, channel: 'push' };
  }

  try {
    // Get OAuth2 token for FCM v1 API
    const tokenRes = await fetch(
      `https://oauth2.googleapis.com/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion:  config.firebase.privateKey,
        }),
      }
    );
    const tokenData = await tokenRes.json() as { access_token: string };

    const response = await fetch(
      `https://fcm.googleapis.com/v1/projects/${config.firebase.projectId}/messages:send`,
      {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${tokenData.access_token}`,
        },
        body: JSON.stringify({
          message: {
            token:        fcmToken,
            notification: { title, body },
            data:         data || {},
            android:      { priority: 'high' },
          },
        }),
      }
    );
    const result = await response.json() as { name?: string };
    return {
      success:           response.ok,
      providerMessageId: result.name || null,
      channel:           'push',
    };
  } catch (err) {
    logger.error('FCM push failed', { err });
    return { success: false, providerMessageId: null, channel: 'push' };
  }
}

// ── Log notification ──────────────────────────────────────────

async function logNotification(
  recipientUserId:  string,
  notifType:        string,
  channel:          NotificationChannel,
  templateName:     string,
  variables:        Record<string, unknown>,
  result:           SendResult,
  relatedBookingId?: string
): Promise<void> {
  try {
    await query(
      `INSERT INTO notification_log (
         recipient_user_id, notification_type, channel, template_name,
         template_variables, delivery_status, provider_message_id,
         related_booking_id, sent_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
      [
        recipientUserId,
        notifType,
        channel,
        templateName,
        JSON.stringify(variables),
        result.success ? 'sent' : 'failed',
        result.providerMessageId,
        relatedBookingId || null,
      ]
    );
  } catch (err) {
    // Never crash on notification logging failure
    logger.error('Failed to log notification', { err });
  }
}

// ── HIGH-LEVEL NOTIFICATION FUNCTIONS ────────────────────────

export async function notifyBookingConfirmed(
  bookingId:    string,
  patientUserId: string,
  doctorUserId: string,
  clinicAdminUserIds: string[]
): Promise<void> {

  // Get booking details for message
  const result = await query<{
    booking_reference: string;
    patient_phone:     string;
    doctor_name:       string;
    clinic_name:       string;
    appointment_start_at: Date;
    doctor_fcm_token:  string | null;
    patient_fcm_token: string | null;
  }>(
    `SELECT
       b.booking_reference,
       u_patient.phone as patient_phone,
       u_doc.full_name as doctor_name,
       cp.name as clinic_name,
       b.appointment_start_at,
       u_doc.fcm_token as doctor_fcm_token,
       u_patient.fcm_token as patient_fcm_token
     FROM bookings b
     JOIN patient_profiles pp ON pp.id = b.patient_id
     JOIN users u_patient      ON u_patient.id = pp.user_id
     JOIN doctor_profiles dp   ON dp.id = b.doctor_id
     JOIN users u_doc          ON u_doc.id = dp.user_id
     JOIN clinic_profiles cp   ON cp.id = b.clinic_id
     WHERE b.id = $1`,
    [bookingId]
  );

  if (result.rowCount === 0) return;

  const b = result.rows[0];
  const apptTime = new Date(b.appointment_start_at).toLocaleString('en-IN', {
    timeZone:     'Asia/Kolkata',
    dateStyle:    'medium',
    timeStyle:    'short',
  });

  // 1. WhatsApp to patient (primary)
  const patientMsg = `✅ *Booking Confirmed!*\n\nRef: ${b.booking_reference}\nDoctor: ${b.doctor_name}\nClinic: ${b.clinic_name}\nTime: ${apptTime} IST\n\nYou will receive a reminder 24 hours before your appointment.`;

  const waResult = await sendWhatsApp(b.patient_phone, patientMsg, 'booking_confirmed');
  await logNotification(patientUserId, 'booking_confirmation', 'whatsapp', 'booking_confirmed',
    { booking_reference: b.booking_reference, doctor_name: b.doctor_name, time: apptTime },
    waResult, bookingId
  );

  // Fallback: SMS if WhatsApp fails
  if (!waResult.success) {
    const smsResult = await sendSms(b.patient_phone, `MedBook: Booking ${b.booking_reference} confirmed with ${b.doctor_name} at ${apptTime}. Ref: medbook.in`);
    await logNotification(patientUserId, 'booking_confirmation', 'sms', 'booking_confirmed_sms',
      { booking_reference: b.booking_reference }, smsResult, bookingId
    );
  }

  // 2. Push to doctor
  if (b.doctor_fcm_token) {
    const pushResult = await sendPush(
      b.doctor_fcm_token,
      'New Appointment',
      `New booking at ${b.clinic_name} — ${apptTime}`,
      { type: 'new_booking', booking_id: bookingId }
    );
    await logNotification(doctorUserId, 'booking_confirmation', 'push', 'new_booking_push',
      { clinic_name: b.clinic_name, time: apptTime }, pushResult, bookingId
    );
  }

  // Update booking confirmation_sent_at
  await query(
    `UPDATE bookings SET confirmation_sent_at = NOW() WHERE id = $1`,
    [bookingId]
  );
}

export async function notifyBookingReminder(
  bookingId: string,
  type:      '24h' | '2h'
): Promise<void> {

  const result = await query<{
    booking_reference:    string;
    patient_phone:        string;
    patient_user_id:      string;
    doctor_name:          string;
    clinic_name:          string;
    clinic_address:       string;
    appointment_start_at: Date;
    patient_fcm_token:    string | null;
  }>(
    `SELECT
       b.booking_reference,
       u_patient.phone as patient_phone,
       u_patient.id as patient_user_id,
       u_doc.full_name as doctor_name,
       cp.name as clinic_name,
       cp.address_line1 || ', ' || COALESCE(cp.neighbourhood,'') as clinic_address,
       b.appointment_start_at,
       u_patient.fcm_token as patient_fcm_token
     FROM bookings b
     JOIN patient_profiles pp ON pp.id = b.patient_id
     JOIN users u_patient      ON u_patient.id = pp.user_id
     JOIN doctor_profiles dp   ON dp.id = b.doctor_id
     JOIN users u_doc          ON u_doc.id = dp.user_id
     JOIN clinic_profiles cp   ON cp.id = b.clinic_id
     WHERE b.id = $1 AND b.status = 'confirmed'`,
    [bookingId]
  );

  if (result.rowCount === 0) return;

  const b  = result.rows[0];
  const when = type === '24h' ? 'tomorrow' : 'in 2 hours';
  const apptTime = new Date(b.appointment_start_at).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', timeStyle: 'short',
  });

  const msg = `⏰ *Appointment Reminder*\n\nYou have an appointment ${when}.\n\nDoctor: ${b.doctor_name}\nClinic: ${b.clinic_name}\nTime: ${apptTime} IST\n\nRef: ${b.booking_reference}`;

  const waResult = await sendWhatsApp(b.patient_phone, msg, `reminder_${type}`);
  await logNotification(b.patient_user_id, `booking_reminder_${type}`, 'whatsapp',
    `reminder_${type}`, { doctor_name: b.doctor_name, time: apptTime }, waResult, bookingId
  );

  if (!waResult.success) {
    const smsResult = await sendSms(b.patient_phone, `MedBook reminder: ${b.doctor_name} at ${apptTime} ${when}. Ref: ${b.booking_reference}`);
    await logNotification(b.patient_user_id, `booking_reminder_${type}`, 'sms',
      `reminder_${type}_sms`, {}, smsResult, bookingId
    );
  }

  // Update reminder timestamps
  const col = type === '24h' ? 'reminder_24h_sent_at' : 'reminder_2h_sent_at';
  await query(`UPDATE bookings SET ${col} = NOW() WHERE id = $1`, [bookingId]);
}

export async function notifyBookingCancelled(
  bookingId:     string,
  cancelledBy:   string,
  patientUserId: string
): Promise<void> {

  const result = await query<{
    booking_reference: string;
    patient_phone:     string;
    doctor_name:       string;
    clinic_name:       string;
    appointment_start_at: Date;
  }>(
    `SELECT b.booking_reference, u_patient.phone as patient_phone,
            u_doc.full_name as doctor_name, cp.name as clinic_name,
            b.appointment_start_at
     FROM bookings b
     JOIN patient_profiles pp ON pp.id = b.patient_id
     JOIN users u_patient      ON u_patient.id = pp.user_id
     JOIN doctor_profiles dp   ON dp.id = b.doctor_id
     JOIN users u_doc          ON u_doc.id = dp.user_id
     JOIN clinic_profiles cp   ON cp.id = b.clinic_id
     WHERE b.id = $1`,
    [bookingId]
  );

  if (result.rowCount === 0) return;

  const b = result.rows[0];
  const byText = cancelledBy === 'patient' ? 'You cancelled' : `${cancelledBy === 'clinic' ? b.clinic_name : 'Doctor'} cancelled`;
  const msg = `❌ *Booking Cancelled*\n\n${byText} your appointment with ${b.doctor_name} at ${b.clinic_name}.\n\nRef: ${b.booking_reference}\n\nTo rebook, open the MedBook app.`;

  const waResult = await sendWhatsApp(b.patient_phone, msg, 'booking_cancelled');
  await logNotification(patientUserId, 'booking_cancelled', 'whatsapp', 'booking_cancelled',
    { doctor_name: b.doctor_name, clinic_name: b.clinic_name }, waResult, bookingId
  );

  if (!waResult.success) {
    await sendSms(b.patient_phone, `MedBook: Your booking ${b.booking_reference} with ${b.doctor_name} has been cancelled.`);
  }
}

export async function notifyScheduleRequest(
  requestId:    string,
  doctorUserId: string
): Promise<void> {

  const result = await query<{
    clinic_name:     string;
    proposed_days:   string[];
    start_time:      string;
    end_time:        string;
    doctor_phone:    string;
    doctor_fcm_token: string | null;
  }>(
    `SELECT cp.name as clinic_name, sr.proposed_days,
            sr.proposed_start_time as start_time, sr.proposed_end_time as end_time,
            u.phone as doctor_phone, u.fcm_token as doctor_fcm_token
     FROM schedule_requests sr
     JOIN clinic_profiles cp ON cp.id = sr.clinic_id
     JOIN doctor_profiles dp ON dp.id = sr.doctor_id
     JOIN users u             ON u.id = dp.user_id
     WHERE sr.id = $1`,
    [requestId]
  );

  if (result.rowCount === 0) return;

  const r   = result.rows[0];
  const days = r.proposed_days.map((d: string) => d.charAt(0).toUpperCase() + d.slice(1, 3)).join(', ');
  const msg  = `📅 *Schedule Request from MedBook*\n\n${r.clinic_name} has sent you a schedule request:\n\nDays: ${days}\nTime: ${r.start_time} – ${r.end_time}\n\nOpen MedBook to Accept or Reject.`;

  const waResult = await sendWhatsApp(r.doctor_phone, msg, 'schedule_request');
  await logNotification(doctorUserId, 'schedule_request', 'whatsapp', 'schedule_request',
    { clinic_name: r.clinic_name, days }, waResult
  );

  if (r.doctor_fcm_token) {
    await sendPush(
      r.doctor_fcm_token,
      'New Schedule Request',
      `${r.clinic_name} wants to add ${days} ${r.start_time}–${r.end_time} to your schedule`,
      { type: 'schedule_request', request_id: requestId }
    );
  }
}

export async function notifyReviewRequest(
  bookingId:    string,
  patientUserId: string
): Promise<void> {

  const result = await query<{
    patient_phone: string;
    doctor_name:   string;
    booking_reference: string;
  }>(
    `SELECT u.phone as patient_phone, u_doc.full_name as doctor_name, b.booking_reference
     FROM bookings b
     JOIN patient_profiles pp ON pp.id = b.patient_id
     JOIN users u              ON u.id = pp.user_id
     JOIN doctor_profiles dp   ON dp.id = b.doctor_id
     JOIN users u_doc          ON u_doc.id = dp.user_id
     WHERE b.id = $1`,
    [bookingId]
  );

  if (result.rowCount === 0) return;

  const r   = result.rows[0];
  const msg = `⭐ *How was your appointment?*\n\nWe hope your visit with ${r.doctor_name} went well.\n\nTap below to leave a quick review — it helps other patients!\n\nRef: ${r.booking_reference}`;

  const waResult = await sendWhatsApp(r.patient_phone, msg, 'review_request');
  await logNotification(patientUserId, 'review_request', 'whatsapp', 'review_request',
    { doctor_name: r.doctor_name }, waResult, bookingId
  );

  await query(
    `UPDATE bookings SET review_requested_at = NOW() WHERE id = $1`,
    [bookingId]
  );
}
