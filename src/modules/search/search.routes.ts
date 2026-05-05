// src/modules/search/search.routes.ts
// ============================================================
//  Search Routes + Controller (combined — thin layer)
//  All PUBLIC — no auth required for search
// ============================================================

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { validate } from '../../middleware';
import { searchDoctors, SPECIALTIES_LIST, getActiveCities } from './search.service';
import { sendSuccess, getPaginationParams } from '../../utils/response';

const router = Router();

// ── Validation ─────────────────────────────────────────────────
const SearchQuerySchema = z.object({
  q:              z.string().max(100).optional(),
  city:           z.string().max(100).optional(),
  neighbourhood:  z.string().max(100).optional(),
  specialty:      z.string().optional(),
  language:       z.string().optional(),
  gender:         z.enum(['male', 'female']).optional(),
  available_on:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  max_fee_paise:  z.string().transform(Number).optional(),
  sort:           z.enum(['rating','fee_asc','fee_desc','experience','relevance']).optional(),
  page:           z.string().transform(Number).optional(),
  per_page:       z.string().transform(Number).optional(),
});

// ── GET /v1/search/doctors ────────────────────────────────────
router.get('/doctors', validate(SearchQuerySchema, 'query'), async (req: Request, res: Response) => {
  const { page, per_page, offset } = getPaginationParams(
    req.query.page, req.query.per_page, 50
  );

  const { doctors, total } = await searchDoctors({
    ...req.query as Record<string, string>,
    page,
    per_page,
    offset,
  } as Parameters<typeof searchDoctors>[0]);

  sendSuccess(res, { doctors }, 200, { page, per_page, total });
});

// ── GET /v1/search/specialties ────────────────────────────────
router.get('/specialties', (_req: Request, res: Response) => {
  sendSuccess(res, { specialties: SPECIALTIES_LIST });
});

// ── GET /v1/search/cities ─────────────────────────────────────
router.get('/cities', async (_req: Request, res: Response) => {
  const cities = await getActiveCities();
  sendSuccess(res, { cities });
});

export { router as searchRoutes };
