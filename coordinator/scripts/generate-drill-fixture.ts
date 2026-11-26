#!/usr/bin/env tsx
/**
 * Generate a sanitized fixture database for disaster recovery drills.
 *
 * Creates representative records across all table types:
 * - Active orders (src_locked, dst_locked)
 * - Terminal orders (completed, refunded, failed, cancelled)
 * - Order events with realistic progression
 * - Audit log entries
 * - Encrypted secrets (sanitized)
 * - Chain cursors and checkpoints
 *
 * The fixture excludes production secrets and uses deterministic IDs for
 * reproducible drills.
 */

import { randomBytes, createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite');

interface Args {
  out: string;
  activeOrders: number;
  terminalOrders: number;
  withSecrets: boolean;
}

function usage(): string {
  return [
    'Usage: tsx scripts/generate-drill-fixture.ts [options]',
    '',
    'Options:',
    '  --out <path>              Output database path (required)',
    '  --active-orders <n>       Number of active orders (default: 50)',
    '  --terminal-orders <n>     Number of terminal orders (default: 200)',
    '  --with-secrets            Include encrypted secrets (default: false)',
  ].join('\n');
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    out: '',
    activeOrders: 50,
    terminalOrders: 200,
    withSecrets: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    }
    if (arg === '--out') {
      args.out = requireValue(argv, ++i, arg);
      continue;
    }
    if (arg === '--active-orders') {
      args.activeOrders = parseInt(requireValue(argv, ++i, arg), 10);
      continue;
    }
    if (arg === '--terminal-orders') {
      args.terminalOrders = parseInt(requireValue(argv, ++i, arg), 10);
      continue;
    }
    if (arg === '--with-secrets') {
      args.withSecrets = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
  }

  if (!args.out) throw new Error('--out is required\n\n' + usage());
  return args;
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

// ── Deterministic fixture data ───────────────────────────────────────────────

function deterministicHash(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function fixturePublicId(index: number): string {
  return `drill-order-${String(index).padStart(6, '0')}`;
}

function fixtureAddress(chain: string, index: number): string {
  if (chain === 'ethereum') {
    const hash = deterministicHash(`eth-addr-${index}`);
    return `0x${hash.slice(0, 40)}`;
  }
  if (chain === 'soroban') {
    const hash = deterministicHash(`soroban-addr-${index}`);
    return `G${hash.slice(0, 55).toUpperCase()}`;
  }
  if (chain === 'solana') {
    const hash = deterministicHash(`solana-addr-${index}`);
    return hash.slice(0, 44);
  }
  throw new Error(`Unknown chain: ${chain}`);
}

function fixtureTxHash(chain: string, index: number): string {
  const hash = deterministicHash(`${chain}-tx-${index}`);
  return chain === 'ethereum' ? `0x${hash}` : hash;
}

function fixtureSecret(): string {
  return deterministicHash(`drill-secret-${randomBytes(4).toString('hex')}`);
}

function fixtureEncryptedSecret(): string {
  // Sanitized placeholder; not a real encrypted secret
  return Buffer.from(`encrypted:drill:${randomBytes(16).toString('hex')}`).toString('base64');
}

// ── Schema setup ─────────────────────────────────────────────────────────────

const SCHEMA_SQL = `
-- Schema migrations table
CREATE TABLE IF NOT EXISTS schema_migrations (
  migration TEXT PRIMARY KEY NOT NULL,
  applied_at INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0
);

-- Orders table
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'announced', 'src_locked', 'dst_locked', 'completed', 'refunded', 'failed', 'cancelled'
  )),
  direction TEXT NOT NULL CHECK (direction IN ('eth_to_soroban', 'soroban_to_eth', 'eth_to_solana', 'solana_to_eth')),
  src_chain TEXT NOT NULL,
  dst_chain TEXT NOT NULL,
  src_token TEXT NOT NULL,
  dst_token TEXT NOT NULL,
  src_amount TEXT NOT NULL,
  dst_amount TEXT NOT NULL,
  sender TEXT NOT NULL,
  recipient TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  timelock_src INTEGER NOT NULL,
  timelock_dst INTEGER NOT NULL,
  src_htlc_address TEXT,
  dst_htlc_address TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER,
  CHECK (updated_at >= created_at),
  CHECK (archived_at IS NULL OR archived_at >= created_at)
);

CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);

-- Order events table
CREATE TABLE IF NOT EXISTS order_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  chain TEXT NOT NULL,
  tx_hash TEXT,
  block_number INTEGER,
  block_timestamp INTEGER,
  event_data TEXT,
  recorded_at INTEGER NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_order_events_order_id ON order_events(order_id);
CREATE INDEX IF NOT EXISTS idx_order_events_type ON order_events(event_type);

-- Encrypted secrets table
CREATE TABLE IF NOT EXISTS order_secrets (
  order_id INTEGER PRIMARY KEY,
  encrypted_secret TEXT NOT NULL,
  revealed_at INTEGER,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
);

-- Audit log table
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('info', 'warn', 'error')),
  component TEXT NOT NULL,
  action TEXT NOT NULL,
  order_public_id TEXT,
  details TEXT,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_order ON audit_log(order_public_id);

-- Chain cursors table
CREATE TABLE IF NOT EXISTS chain_cursors (
  chain TEXT PRIMARY KEY NOT NULL,
  cursor_type TEXT NOT NULL,
  block_number INTEGER,
  ledger_sequence INTEGER,
  checkpoint_hash TEXT,
  updated_at INTEGER NOT NULL
);

-- Soroban checkpoints table
CREATE TABLE IF NOT EXISTS soroban_checkpoints (
  ledger_sequence INTEGER PRIMARY KEY NOT NULL,
  checkpoint_hash TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  event_count INTEGER NOT NULL DEFAULT 0,
  processed_at INTEGER NOT NULL
);
`;

// ── Record generation ────────────────────────────────────────────────────────

interface OrderFixture {
  publicId: string;
  status: string;
  direction: string;
  srcChain: string;
  dstChain: string;
  events: Array<{ type: string; chain: string; txHash?: string }>;
}

function generateOrderFixtures(active: number, terminal: number): OrderFixture[] {
  const fixtures: OrderFixture[] = [];
  let index = 0;

  // Active orders: src_locked
  for (let i = 0; i < Math.floor(active / 2); i++) {
    fixtures.push({
      publicId: fixturePublicId(index++),
      status: 'src_locked',
      direction: 'eth_to_soroban',
      srcChain: 'ethereum',
      dstChain: 'soroban',
      events: [
        { type: 'announced', chain: 'ethereum' },
        { type: 'src_locked', chain: 'ethereum', txHash: fixtureTxHash('ethereum', index) },
      ],
    });
  }

  // Active orders: dst_locked
  for (let i = 0; i < Math.floor(active / 2); i++) {
    fixtures.push({
      publicId: fixturePublicId(index++),
      status: 'dst_locked',
      direction: 'soroban_to_eth',
      srcChain: 'soroban',
      dstChain: 'ethereum',
      events: [
        { type: 'announced', chain: 'soroban' },
        { type: 'src_locked', chain: 'soroban', txHash: fixtureTxHash('soroban', index) },
        { type: 'dst_locked', chain: 'ethereum', txHash: fixtureTxHash('ethereum', index) },
      ],
    });
  }

  // Terminal orders: completed
  for (let i = 0; i < Math.floor(terminal * 0.7); i++) {
    fixtures.push({
      publicId: fixturePublicId(index++),
      status: 'completed',
      direction: 'eth_to_soroban',
      srcChain: 'ethereum',
      dstChain: 'soroban',
      events: [
        { type: 'announced', chain: 'ethereum' },
        { type: 'src_locked', chain: 'ethereum', txHash: fixtureTxHash('ethereum', index) },
        { type: 'dst_locked', chain: 'soroban', txHash: fixtureTxHash('soroban', index) },
        { type: 'src_claimed', chain: 'ethereum', txHash: fixtureTxHash('ethereum', index + 1) },
        { type: 'dst_claimed', chain: 'soroban', txHash: fixtureTxHash('soroban', index + 1) },
      ],
    });
  }

  // Terminal orders: refunded
  for (let i = 0; i < Math.floor(terminal * 0.2); i++) {
    fixtures.push({
      publicId: fixturePublicId(index++),
      status: 'refunded',
      direction: 'soroban_to_eth',
      srcChain: 'soroban',
      dstChain: 'ethereum',
      events: [
        { type: 'announced', chain: 'soroban' },
        { type: 'src_locked', chain: 'soroban', txHash: fixtureTxHash('soroban', index) },
        { type: 'src_refunded', chain: 'soroban', txHash: fixtureTxHash('soroban', index + 1) },
      ],
    });
  }

  // Terminal orders: failed
  for (let i = 0; i < Math.floor(terminal * 0.1); i++) {
    fixtures.push({
      publicId: fixturePublicId(index++),
      status: 'failed',
      direction: 'eth_to_solana',
      srcChain: 'ethereum',
      dstChain: 'solana',
      events: [{ type: 'announced', chain: 'ethereum' }],
    });
  }

  return fixtures;
}

function insertFixtures(db: InstanceType<typeof DatabaseSync>, args: Args): void {
  const now = Math.floor(Date.now() / 1000);
  const baseTime = now - 7 * 24 * 60 * 60; // 7 days ago

  // Insert migration records
  const migrations = [
    '001_initial.sql',
    '002_solana_support.sql',
    '003_secret_encryption.sql',
    '007_audit_log.sql',
    '009_chain_cursors.sql',
    '010_soroban_checkpoints.sql',
    '013_replay_safety.sql',
  ];

  const insertMigration = db.prepare(
    'INSERT INTO schema_migrations (migration, applied_at, duration_ms) VALUES (?, ?, ?)'
  );

  migrations.forEach((m, i) => {
    insertMigration.run(m, baseTime + i * 60, 0);
  });

  // Generate and insert orders
  const fixtures = generateOrderFixtures(args.activeOrders, args.terminalOrders);

  const insertOrder = db.prepare(`
    INSERT INTO orders (
      public_id, status, direction, src_chain, dst_chain,
      src_token, dst_token, src_amount, dst_amount,
      sender, recipient, secret_hash, timelock_src, timelock_dst,
      created_at, updated_at, archived_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertEvent = db.prepare(`
    INSERT INTO order_events (
      order_id, event_type, chain, tx_hash, block_number, block_timestamp, recorded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const insertSecret = db.prepare(
    'INSERT INTO order_secrets (order_id, encrypted_secret, revealed_at) VALUES (?, ?, ?)'
  );

  const insertAudit = db.prepare(`
    INSERT INTO audit_log (timestamp, level, component, action, order_public_id, details)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  fixtures.forEach((fixture, idx) => {
    const orderTime = baseTime + idx * 300; // 5 minutes apart
    const isTerminal = ['completed', 'refunded', 'failed', 'cancelled'].includes(fixture.status);

    const result = insertOrder.run(
      fixture.publicId,
      fixture.status,
      fixture.direction,
      fixture.srcChain,
      fixture.dstChain,
      fixture.srcChain === 'ethereum' ? '0xUSDC' : 'USDC',
      fixture.dstChain === 'ethereum' ? '0xUSDC' : 'USDC',
      '1000000000', // 1000 tokens
      '995000000', // 995 tokens (5% fee)
      fixtureAddress(fixture.srcChain, idx),
      fixtureAddress(fixture.dstChain, idx),
      deterministicHash(`secret-${idx}`),
      orderTime + 3600,
      orderTime + 7200,
      orderTime,
      orderTime + fixture.events.length * 60,
      isTerminal ? orderTime + 3600 : null
    );

    const orderId = Number(result.lastInsertRowid);

    // Insert events
    fixture.events.forEach((evt, evtIdx) => {
      insertEvent.run(
        orderId,
        evt.type,
        evt.chain,
        evt.txHash || null,
        1000000 + idx * 10 + evtIdx,
        orderTime + evtIdx * 60,
        orderTime + evtIdx * 60
      );
    });

    // Insert encrypted secret if requested
    if (args.withSecrets && (fixture.status === 'dst_locked' || fixture.status === 'completed')) {
      insertSecret.run(orderId, fixtureEncryptedSecret(), null);
    }

    // Insert audit log entry
    insertAudit.run(
      orderTime,
      'info',
      'fixture-generator',
      'order_created',
      fixture.publicId,
      JSON.stringify({ status: fixture.status, direction: fixture.direction })
    );
  });

  // Insert chain cursors
  const insertCursor = db.prepare(
    'INSERT INTO chain_cursors (chain, cursor_type, block_number, updated_at) VALUES (?, ?, ?, ?)'
  );

  insertCursor.run('ethereum', 'listener', 20000000, now);
  insertCursor.run('soroban', 'listener', 5000000, now);
  insertCursor.run('solana', 'listener', 250000000, now);

  // Insert soroban checkpoints
  const insertCheckpoint = db.prepare(
    'INSERT INTO soroban_checkpoints (ledger_sequence, checkpoint_hash, timestamp, event_count, processed_at) VALUES (?, ?, ?, ?, ?)'
  );

  for (let i = 0; i < 10; i++) {
    const ledger = 5000000 - i * 1000;
    insertCheckpoint.run(
      ledger,
      deterministicHash(`checkpoint-${ledger}`),
      now - i * 300,
      i * 5,
      now - i * 300
    );
  }

  console.log(`\nFixture summary:`);
  console.log(`  Orders: ${fixtures.length} total`);
  console.log(`    Active: ${fixtures.filter(f => !['completed', 'refunded', 'failed', 'cancelled'].includes(f.status)).length}`);
  console.log(`    Terminal: ${fixtures.filter(f => ['completed', 'refunded', 'failed', 'cancelled'].includes(f.status)).length}`);
  console.log(`  Events: ${fixtures.reduce((sum, f) => sum + f.events.length, 0)}`);
  console.log(`  Audit log entries: ${fixtures.length}`);
  console.log(`  Chain cursors: 3`);
  console.log(`  Soroban checkpoints: 10`);
  if (args.withSecrets) {
    console.log(`  Encrypted secrets: ${fixtures.filter(f => f.status === 'dst_locked' || f.status === 'completed').length}`);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const path = resolve(args.out);

  if (existsSync(path)) {
    throw new Error(`Refusing to overwrite existing file: ${path}`);
  }

  console.log(`Generating drill fixture: ${path}`);

  const db = new DatabaseSync(path);
  try {
    db.exec('BEGIN TRANSACTION');
    db.exec(SCHEMA_SQL);
    insertFixtures(db, args);
    db.exec('COMMIT');

    // Verify integrity
    const integrityResult = db.prepare('PRAGMA integrity_check').get() as Record<string, string>;
    const result = Object.values(integrityResult)[0];
    if (result !== 'ok') {
      throw new Error(`Integrity check failed: ${result}`);
    }

    console.log(`\nFixture created successfully: ${path}`);
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.close();
  }
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
