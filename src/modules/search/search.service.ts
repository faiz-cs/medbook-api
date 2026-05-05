// src/modules/search/search.service.ts
// ============================================================
//  Search Service
//  Powers the patient-facing doctor search screen
//  Uses doctor_search_view from the DB + time_slots for availability
// ============================================================

import { query } from '../../config/database';
import { cacheGet, cacheSet } from '../../config/redis';
import { MedicalSpecialty } from '../../types';
import crypto from 'crypto';

// ── Types ─────────────────────────────────────────────────────

export interface SearchFilters {
  q?:             string;
  city?:          string;
  neighbourhood?: string;
  specialty?:     MedicalSpecialty;
  language?:      string;
  gender?:        string;
  available_on?:  string;
  max_fee_paise?: number;
  sort?:          'rating' | 'fee_asc' | 'fee_desc' | 'experience' | 'relevance';
  page:           number;
  per_page:       number;
  offset:         number;
}

export interface DoctorSearchResult {
  doctor_profile_id:     string;
  doctor_name:           string;
  avatar_url:            string | null;
  primary_specialty:     string;
  years_of_experience:   number;
  languages_spoken:      string[];
  consultation_fee_paise: number;
  avg_rating:            number;
  total_reviews:         number;
  nmc_verified:          boolean;
  active_location_count: number;
  city:                  string;
  next_available_slot:   string | null;
  is_available_today:    boolean;
}

// ── Doctor Search ─────────────────────────────────────────────
export async function searchDoctors(
  filters: SearchFilters
): Promise<{ doctors: DoctorSearchResult[]; total: number }> {

  // Build a hash of the filters to use as cache key
  const filterHash = crypto
    .createHash('md5')
    .update(JSON.stringify(filters))
    .digest('hex');

  const cacheKey = `search:${filterHash}`;

  // Try cache first (30 second TTL for search results)
  const cached = await cacheGet<{ doctors: DoctorSearchResult[]; total: number }>(cacheKey);
  if (cached) return cached;

  // Build WHERE clause dynamically
  const conditions: string[] = [
    'dsv.is_visible = TRUE',   // only verified, active doctors
  ];
  const values: unknown[] = [];
  let   idx = 1;

  // City filter
  if (filters.city) {
    conditions.push(`LOWER(dsv.city) = LOWER($${idx++})`);
    values.push(filters.city);
  }

  // Specialty filter
  if (filters.specialty) {
    conditions.push(
      `(dsv.primary_specialty = $${idx} OR $${idx}::medical_specialty = ANY(dsv.secondary_specialties))`
    );
    values.push(filters.specialty);
    idx++;
  }

  // Language filter (checks the languages_spoken array)
  if (filters.language) {
    conditions.push(`$${idx++} = ANY(dsv.languages_spoken)`);
    values.push(filters.language);
  }

  // Fee filter
  if (filters.max_fee_paise) {
    conditions.push(`dsv.consultation_fee_paise <= $${idx++}`);
    values.push(filters.max_fee_paise);
  }

  // Free-text search (on doctor name and bio)
  if (filters.q) {
    conditions.push(
      `(LOWER(dsv.doctor_name) LIKE LOWER($${idx}) OR LOWER(dsv.bio) LIKE LOWER($${idx}))`
    );
    values.push(`%${filters.q}%`);
    idx++;
  }

  // Availability filter — only show doctors with at least one slot on that date
  if (filters.available_on) {
    conditions.push(
      `EXISTS (
        SELECT 1 FROM time_slots ts
        WHERE ts.doctor_id = dsv.user_id
          AND ts.slot_date = $${idx++}::date
          AND ts.status = 'available'
        LIMIT 1
      )`
    );
    values.push(filters.available_on);
  }

  const whereClause = conditions.length > 0
    ? `WHERE ${conditions.join(' AND ')}`
    : '';

  // Sort clause
  const sortMap: Record<string, string> = {
    rating:     'dsv.avg_rating DESC, dsv.total_reviews DESC',
    fee_asc:    'dsv.consultation_fee_paise ASC',
    fee_desc:   'dsv.consultation_fee_paise DESC',
    experience: 'dsv.years_of_experience DESC',
    relevance:  'dsv.avg_rating DESC',
  };
  const orderBy = sortMap[filters.sort || 'relevance'];

  // Count total results (for pagination)
  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM doctor_search_view dsv ${whereClause}`,
    values
  );
  const total = parseInt(countResult.rows[0]?.count || '0', 10);

  // Main query with pagination
  const searchResult = await query<{
    doctor_profile_id:      string;
    user_id:                string;
    doctor_name:            string;
    avatar_url:             string | null;
    primary_specialty:      string;
    secondary_specialties:  string[];
    years_of_experience:    number;
    languages_spoken:       string[];
    consultation_fee_paise: number;
    avg_rating:             number;
    total_reviews:          number;
    nmc_number:             string | null;
    active_location_count:  number;
    city:                   string;
  }>(
    `SELECT * FROM doctor_search_view dsv
     ${whereClause}
     ORDER BY ${orderBy}
     LIMIT $${idx++} OFFSET $${idx++}`,
    [...values, filters.per_page, filters.offset]
  );

  if (searchResult.rowCount === 0) {
    return { doctors: [], total };
  }

  // For each doctor, get next available slot
  const today = new Date().toISOString().split('T')[0];

  const doctorIds = searchResult.rows.map(r => r.doctor_profile_id);

  // Batch query: get next available slot for all result doctors in one query
  const nextSlotsResult = await query<{
    doctor_id:       string;
    next_slot_at:    string;
    is_today:        boolean;
  }>(
    `SELECT DISTINCT ON (ts.doctor_id)
       ts.doctor_id,
       ts.slot_start_at::text as next_slot_at,
       (ts.slot_date = CURRENT_DATE) as is_today
     FROM time_slots ts
     WHERE ts.doctor_id = ANY($1::uuid[])
       AND ts.status = 'available'
       AND ts.slot_date >= CURRENT_DATE
     ORDER BY ts.doctor_id, ts.slot_start_at`,
    [doctorIds]
  );

  // Build a map for quick lookup
  const slotMap = new Map(nextSlotsResult.rows.map(r => [r.doctor_id, r]));

  // Build the final response array
  const doctors: DoctorSearchResult[] = searchResult.rows.map(row => {
    const slotInfo = slotMap.get(row.doctor_profile_id);
    return {
      doctor_profile_id:      row.doctor_profile_id,
      doctor_name:            row.doctor_name,
      avatar_url:             row.avatar_url,
      primary_specialty:      row.primary_specialty,
      years_of_experience:    row.years_of_experience,
      languages_spoken:       row.languages_spoken,
      consultation_fee_paise: row.consultation_fee_paise,
      avg_rating:             parseFloat(row.avg_rating as unknown as string) || 0,
      total_reviews:          row.total_reviews,
      nmc_verified:           !!row.nmc_number,
      active_location_count:  parseInt(row.active_location_count as unknown as string, 10),
      city:                   row.city,
      next_available_slot:    slotInfo?.next_slot_at || null,
      is_available_today:     slotInfo?.is_today || false,
    };
  });

  const result = { doctors, total };

  // Cache for 30 seconds
  await cacheSet(cacheKey, result, 30);

  return result;
}

// ── Specialties list ──────────────────────────────────────────
export const SPECIALTIES_LIST = [
  { key: 'general_physician',  label: 'General Physician', label_hi: 'सामान्य चिकित्सक', icon: '🩺' },
  { key: 'cardiology',         label: 'Cardiology',        label_hi: 'हृदय रोग',          icon: '❤️' },
  { key: 'dermatology',        label: 'Dermatology',       label_hi: 'त्वचा रोग',         icon: '🧴' },
  { key: 'orthopedics',        label: 'Orthopedics',       label_hi: 'हड्डी रोग',         icon: '🦴' },
  { key: 'gynecology',         label: 'Gynecology',        label_hi: 'स्त्री रोग',        icon: '👩‍⚕️' },
  { key: 'pediatrics',         label: 'Pediatrics',        label_hi: 'बाल रोग',           icon: '👶' },
  { key: 'ent',                label: 'ENT',               label_hi: 'कान नाक गला',       icon: '👂' },
  { key: 'neurology',          label: 'Neurology',         label_hi: 'न्यूरोलॉजी',       icon: '🧠' },
  { key: 'ophthalmology',      label: 'Ophthalmology',     label_hi: 'नेत्र रोग',        icon: '👁️' },
  { key: 'psychiatry',         label: 'Psychiatry',        label_hi: 'मनोरोग',           icon: '🧘' },
  { key: 'urology',            label: 'Urology',           label_hi: 'मूत्र रोग',        icon: '⚕️' },
  { key: 'gastroenterology',   label: 'Gastroenterology',  label_hi: 'पेट के रोग',       icon: '🫁' },
  { key: 'pulmonology',        label: 'Pulmonology',       label_hi: 'फेफड़े के रोग',    icon: '🫁' },
  { key: 'endocrinology',      label: 'Endocrinology',     label_hi: 'हार्मोन रोग',     icon: '🔬' },
  { key: 'dentistry',          label: 'Dentistry',         label_hi: 'दंत चिकित्सा',    icon: '🦷' },
  { key: 'physiotherapy',      label: 'Physiotherapy',     label_hi: 'फिजियोथेरेपी',   icon: '🏃' },
  { key: 'general_surgery',    label: 'General Surgery',   label_hi: 'सामान्य शल्य',   icon: '🏥' },
];

// ── Active cities ──────────────────────────────────────────────
export async function getActiveCities(): Promise<string[]> {
  const result = await query<{ city: string }>(
    `SELECT DISTINCT city FROM doctor_search_view
     ORDER BY city`,
  );
  return result.rows.map(r => r.city);
}
