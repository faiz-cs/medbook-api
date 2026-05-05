// scripts/migrate-render.ts
// ============================================================
//  Render Migration Script
//  Runs automatically before the API starts on Render
//  Safe to run multiple times — skips already-applied migrations
// ============================================================

import { Client } from 'pg';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const SCHEMA_FILES = [
  'schema/phase1_auth.sql',
  'schema/phase2_profiles.sql',
  'schema/phase3_scheduling.sql',
  'schema/phase4_bookings.sql',
  'schema/phase5_reviews.sql',
];

async function migrate(): Promise<void> {
  const connectionString = process.env.DATABASE_URL || undefined;

  const client = new Client(connectionString ? {
    connectionString,
    ssl: { rejectUnauthorized: false },
  } : {
    host:     process.env.DB_HOST     || 'localhost',
    port:     parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME     || 'medbook_db',
    user:     process.env.DB_USER     || 'medbook_user',
    password: process.env.DB_PASSWORD || '',
    ssl:      process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  });

  try {
    await client.connect();
    console.log('✅ Connected to database');

    // Create migrations tracking table
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    VARCHAR(10) PRIMARY KEY,
        name       VARCHAR(100) NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // Run each schema file if not already applied
    for (let i = 0; i < SCHEMA_FILES.length; i++) {
      const version = String(i + 1).padStart(3, '0');
      const file    = SCHEMA_FILES[i];
      const name    = path.basename(file, '.sql');

      // Check if already applied
      const result = await client.query(
        `SELECT 1 FROM schema_migrations WHERE version = $1`,
        [version]
      );

      if (result.rowCount && result.rowCount > 0) {
        console.log(`  ⏭  [${version}] ${name} — already applied`);
        continue;
      }

      const filePath = path.resolve(process.cwd(), file);
      if (!fs.existsSync(filePath)) {
        console.log(`  ⚠️  [${version}] ${file} — file not found, skipping`);
        continue;
      }

      const sql = fs.readFileSync(filePath, 'utf-8');

      console.log(`  → [${version}] ${name}...`);
      const start = Date.now();

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          `INSERT INTO schema_migrations (version, name) VALUES ($1, $2)`,
          [version, name]
        );
        await client.query('COMMIT');
        console.log(`  ✅ [${version}] ${name} applied in ${Date.now() - start}ms`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }

    console.log('\n✅ Database migrations complete\n');

  } catch (err) {
    console.error('❌ Migration failed:', err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

migrate();
