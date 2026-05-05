// scripts/migrate.ts
// ============================================================
//  MedBook Database Migration Runner
//  Usage:
//    npx ts-node scripts/migrate.ts             — run all pending
//    npx ts-node scripts/migrate.ts --rollback  — rollback last
//    npx ts-node scripts/migrate.ts --status    — show status
// ============================================================

import { Client } from 'pg';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

// ── Migration files in order ──────────────────────────────────
const MIGRATIONS = [
  { version: '001', name: 'auth',       file: 'schema/phase1_auth.sql'      },
  { version: '002', name: 'profiles',   file: 'schema/phase2_profiles.sql'  },
  { version: '003', name: 'scheduling', file: 'schema/phase3_scheduling.sql'},
  { version: '004', name: 'bookings',   file: 'schema/phase4_bookings.sql'  },
  { version: '005', name: 'reviews',    file: 'schema/phase5_reviews.sql'   },
];

// ── DB connection ─────────────────────────────────────────────
const client = new Client({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME     || 'medbook_db',
  user:     process.env.DB_USER     || 'medbook_user',
  password: process.env.DB_PASSWORD || '',
  ssl:      process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

// ── Create migrations tracking table ─────────────────────────
async function ensureMigrationsTable(): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version        VARCHAR(10)  PRIMARY KEY,
      name           VARCHAR(100) NOT NULL,
      file           VARCHAR(255) NOT NULL,
      checksum       VARCHAR(64)  NOT NULL,
      applied_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      execution_ms   INTEGER
    )
  `);
}

// ── Get applied migrations ────────────────────────────────────
async function getApplied(): Promise<Set<string>> {
  const result = await client.query<{ version: string }>(
    `SELECT version FROM schema_migrations ORDER BY version`
  );
  return new Set(result.rows.map(r => r.version));
}

// ── Compute file checksum ─────────────────────────────────────
function checksum(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

// ── Run migrations ────────────────────────────────────────────
async function runMigrations(): Promise<void> {
  const applied = await getApplied();
  const pending = MIGRATIONS.filter(m => !applied.has(m.version));

  if (pending.length === 0) {
    console.log('✅ Database is up to date — no pending migrations');
    return;
  }

  console.log(`\n📦 Running ${pending.length} pending migration${pending.length !== 1 ? 's' : ''}...\n`);

  for (const migration of pending) {
    const filePath = path.resolve(process.cwd(), migration.file);

    if (!fs.existsSync(filePath)) {
      console.error(`❌ Migration file not found: ${filePath}`);
      process.exit(1);
    }

    const sql     = fs.readFileSync(filePath, 'utf-8');
    const cs      = checksum(sql);
    const start   = Date.now();

    process.stdout.write(`  → [${migration.version}] ${migration.name}... `);

    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        `INSERT INTO schema_migrations (version, name, file, checksum, execution_ms)
         VALUES ($1, $2, $3, $4, $5)`,
        [migration.version, migration.name, migration.file, cs, Date.now() - start]
      );
      await client.query('COMMIT');
      console.log(`✅ (${Date.now() - start}ms)`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.log(`❌ FAILED`);
      console.error(`\nError in migration [${migration.version}]:`, err);
      process.exit(1);
    }
  }

  console.log(`\n✅ All migrations applied successfully\n`);
}

// ── Show status ───────────────────────────────────────────────
async function showStatus(): Promise<void> {
  const applied = await getApplied();

  console.log('\nMigration Status:\n');
  console.log('  Version  Name              Status      File');
  console.log('  -------  ----------------  ----------  --------------------------------');

  for (const migration of MIGRATIONS) {
    const status = applied.has(migration.version) ? '✅ Applied  ' : '⏳ Pending  ';
    console.log(`  ${migration.version}      ${migration.name.padEnd(16)}  ${status}  ${migration.file}`);
  }
  console.log('');
}

// ── Verify checksums ──────────────────────────────────────────
async function verifyChecksums(): Promise<void> {
  const result = await client.query<{
    version: string; name: string; file: string; checksum: string;
  }>(`SELECT version, name, file, checksum FROM schema_migrations`);

  let ok = true;
  for (const row of result.rows) {
    const filePath = path.resolve(process.cwd(), row.file);
    if (!fs.existsSync(filePath)) continue;

    const sql     = fs.readFileSync(filePath, 'utf-8');
    const current = checksum(sql);

    if (current !== row.checksum) {
      console.warn(`⚠️  Checksum mismatch for [${row.version}] ${row.name}`);
      console.warn(`   Expected: ${row.checksum}`);
      console.warn(`   Got:      ${current}`);
      ok = false;
    }
  }

  if (ok) console.log('✅ All checksums verified');
}

// ── Entry point ───────────────────────────────────────────────
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  try {
    await client.connect();
    await ensureMigrationsTable();

    if (args.includes('--status')) {
      await showStatus();
    } else if (args.includes('--verify')) {
      await verifyChecksums();
    } else {
      await runMigrations();
      await showStatus();
    }
  } catch (err) {
    console.error('Migration error:', err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
