# MedBook India — Backend API
Node.js/TypeScript REST API · 29 source files · 58 endpoints · Zero TypeScript errors

## Stack
Node.js 20, TypeScript 5, Express, PostgreSQL 15, Redis 7, Zod, JWT, MSG91, Gupshup, FCM, Razorpay, AWS S3, Docker, ECS Fargate (Mumbai)

## Quick Start
```bash
# Docker (recommended)
cp .env.example .env && docker-compose up -d

# Local dev
npm install && npm run dev
```

## Structure
```
src/
├── config/          env · database · redis · logger
├── middleware/       authenticate · requireRole · validate · errorHandler
├── modules/
│   ├── auth/         OTP · JWT · sessions
│   ├── profile/      Patient · Doctor (NMC) · Clinic
│   ├── search/       Doctor search with filters
│   ├── scheduling/   3-way sync: clinic proposes → doctor approves → slots live
│   ├── clinic/       Doctor linking · queue · dashboard
│   ├── booking/      Initiate → confirm → cancel/reschedule → review
│   ├── doctor/       Public profile · reviews · dashboard
│   ├── notification/ WhatsApp · SMS · FCM push
│   ├── payment/      Razorpay UPI · verify · refund · webhook · S3 presign
│   └── admin/        Verification · flags · moderation · analytics
├── jobs/             9 cron jobs
├── types/            TypeScript types
└── utils/            Response helpers
schema/               5 SQL files — run in order
```

## Endpoints: 58 total
Auth (5) · Profile (8) · Search (3) · Doctors (14) · Bookings (7) · Clinic (9) · Payments (4) · Uploads (1) · Admin (12) · Health (1) = 64 routes

## Background Jobs (9)
Slot generation · Lock expiry · Slot expiry · Schedule escalation · Auto-complete · 24h reminder · 2h reminder · Review request · No-show detection

## Database
```bash
psql -U medbook_user -d medbook_db -f schema/phase1_auth.sql
psql -U medbook_user -d medbook_db -f schema/phase2_profiles.sql
psql -U medbook_user -d medbook_db -f schema/phase3_scheduling.sql
psql -U medbook_user -d medbook_db -f schema/phase4_bookings.sql
psql -U medbook_user -d medbook_db -f schema/phase5_reviews.sql
```
18 tables · 27 DB functions · 5 views

## Deploy
CI/CD via GitHub Actions → AWS ECR → ECS Fargate (ap-south-1)
See `.github/workflows/deploy.yml`
