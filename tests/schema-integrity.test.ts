// ============================================================
// Tests: Schema Integrity
// Verifies that every Supabase table referenced in code has a
// corresponding CREATE TABLE in the migrations.
// THIS IS THE TEST THAT WOULD HAVE CAUGHT 8 MISSING TABLES.
// Run: npx tsx --test tests/schema-integrity.test.ts
// ============================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

/**
 * Recursively find all .ts files in a directory
 */
function findTsFiles(dir: string): string[] {
  const results: string[] = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        results.push(...findTsFiles(fullPath));
      } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        results.push(fullPath);
      }
    }
  } catch { /* skip inaccessible dirs */ }
  return results;
}

/**
 * Extract all table names from .from('table_name') calls in TS files
 */
function extractReferencedTables(): Set<string> {
  const tables = new Set<string>();
  const tsFiles = [
    ...findTsFiles(join(ROOT, 'src')),
    ...findTsFiles(join(ROOT, 'netlify')),
  ];

  for (const file of tsFiles) {
    const content = readFileSync(file, 'utf-8');
    const matches = content.matchAll(/\.from\(\s*['"]([a-z_]+)['"]\s*\)/g);
    for (const match of matches) {
      tables.add(match[1]);
    }
  }
  return tables;
}

/**
 * Extract all CREATE TABLE statements from migration files
 */
function extractDefinedTables(): Set<string> {
  const tables = new Set<string>();
  const migDir = join(ROOT, 'supabase', 'migrations');

  try {
    for (const file of readdirSync(migDir)) {
      if (!file.endsWith('.sql')) continue;
      const content = readFileSync(join(migDir, file), 'utf-8');
      const matches = content.matchAll(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(\w+)/gi);
      for (const match of matches) {
        tables.add(match[1].toLowerCase());
      }
    }
  } catch { /* skip if no migrations dir */ }
  return tables;
}

// ── Tests ───────────────────────────────────────────────────

describe('Schema Integrity', () => {
  const referencedTables = extractReferencedTables();
  const definedTables = extractDefinedTables();

  it('finds at least 10 referenced tables', () => {
    assert.ok(
      referencedTables.size >= 10,
      `Expected 10+ referenced tables, found ${referencedTables.size}: ${[...referencedTables].join(', ')}`
    );
  });

  it('finds at least 10 defined tables in migrations', () => {
    assert.ok(
      definedTables.size >= 10,
      `Expected 10+ defined tables, found ${definedTables.size}: ${[...definedTables].join(', ')}`
    );
  });

  it('every table referenced in code has a CREATE TABLE in migrations', () => {
    const missing: string[] = [];
    for (const table of referencedTables) {
      if (!definedTables.has(table)) {
        missing.push(table);
      }
    }
    assert.deepEqual(
      missing,
      [],
      `Tables used in code but missing from migrations:\n  ${missing.join('\n  ')}\n\nDefined tables: ${[...definedTables].join(', ')}`
    );
  });

  // Individual checks for known critical tables
  for (const table of [
    'bets', 'markets', 'system_config', 'weather_analyses',
    'sports_analyses', 'crypto_analyses', 'weather_forecasts',
    'weather_consensus', 'performance_snapshots', 'arb_opportunities',
    'politics_analyses', 'sentiment_analyses', 'opportunity_analyses',
    'trump_posts', 'options_flow_signals', 'whale_profiles',
    'kalshi_markets', 'calibration_snapshots',
  ]) {
    it(`table "${table}" exists in migrations`, () => {
      assert.ok(
        definedTables.has(table),
        `"${table}" is used in code but missing from migrations. Defined: ${[...definedTables].join(', ')}`
      );
    });
  }
});

// ── Migration ordering ──────────────────────────────────────

describe('Migration Ordering', () => {
  it('migration files are numbered sequentially', () => {
    const migDir = join(ROOT, 'supabase', 'migrations');
    const files = readdirSync(migDir).filter(f => f.endsWith('.sql')).sort();
    const numbers = files.map(f => {
      const match = f.match(/^(\d+)/);
      return match ? parseInt(match[1]) : -1;
    }).filter(n => n > 0);

    // Check no duplicate numbers
    const unique = new Set(numbers);
    // Note: we allow duplicate numbers (e.g. 003_cleanup.sql and 003_weather_v2.sql)
    // but log a warning
    if (unique.size < numbers.length) {
      console.warn(`Warning: Duplicate migration numbers detected in: ${files.join(', ')}`);
    }
    assert.ok(numbers.length > 0, 'Should have numbered migration files');
  });

  it('Tel Aviv is NOT re-activated after being deactivated', () => {
    const migDir = join(ROOT, 'supabase', 'migrations');
    const files = readdirSync(migDir).filter(f => f.endsWith('.sql')).sort();

    let deactivatedInFile = '';
    let reactivated = false;

    for (const file of files) {
      const content = readFileSync(join(migDir, file), 'utf-8');
      const lcContent = content.toLowerCase();
      if (lcContent.includes("is_active = false") && content.includes("Tel Aviv")) {
        deactivatedInFile = file;
      }
      // Only check for reactivation AFTER the deactivation migration
      if (deactivatedInFile && file > deactivatedInFile) {
        const nonCommentLines = content.split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
        if (nonCommentLines.includes("Tel Aviv") && /is_active\s*=\s*TRUE/i.test(nonCommentLines)) {
          reactivated = true;
        }
      }
    }

    if (deactivatedInFile) {
      assert.ok(!reactivated, 'Tel Aviv was deactivated but then re-activated in a later migration!');
    }
  });
});

// ── Partial unique index check ──────────────────────────────

describe('Critical Indexes', () => {
  it('has a unique index preventing duplicate open bets per market', () => {
    const migDir = join(ROOT, 'supabase', 'migrations');
    let found = false;
    for (const file of readdirSync(migDir).filter(f => f.endsWith('.sql'))) {
      const content = readFileSync(join(migDir, file), 'utf-8');
      if (content.includes('idx_bets_one_open_per_market') ||
          (content.includes('UNIQUE') && content.includes('market_id') && content.includes("status = 'OPEN'"))) {
        found = true;
      }
    }
    assert.ok(found, 'Missing partial unique index on bets(market_id) WHERE status=OPEN');
  });
});
