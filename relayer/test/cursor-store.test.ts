import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { CursorStore } from '../src/utils/cursor-store.js';

const TEST_DIR = join(process.cwd(), '.cursor-test');

describe('CursorStore', () => {
  let store: CursorStore;

  beforeEach(() => {
    // Clean slate before each test
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
    store = new CursorStore({ storageDir: TEST_DIR });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it('returns null when no cursor has been saved for a label', () => {
    expect(store.load('nonexistent')).toBeNull();
  });

  it('persists and retrieves a cursor value', () => {
    store.save('test-poller', 42);
    expect(store.load('test-poller')).toBe(42);
  });

  it('overwrites previous value on subsequent save', () => {
    store.save('test-poller', 100);
    store.save('test-poller', 200);
    expect(store.load('test-poller')).toBe(200);
  });

  it('supports multiple independent labels', () => {
    store.save('poller-a', 10);
    store.save('poller-b', 20);
    expect(store.load('poller-a')).toBe(10);
    expect(store.load('poller-b')).toBe(20);
  });

  it('persists to disk so a new instance can read it', () => {
    store.save('disk-test', 999);
    const store2 = new CursorStore({ storageDir: TEST_DIR });
    expect(store2.load('disk-test')).toBe(999);
  });

  it('sanitizes label to safe filename characters', () => {
    store.save('my contract!@# poller', 77);
    const store2 = new CursorStore({ storageDir: TEST_DIR });
    expect(store2.load('my contract!@# poller')).toBe(77);
  });

  it('stores a valid JSON file on disk', () => {
    store.save('json-check', 55);
    const files = readFileSync(join(TEST_DIR, 'json-check.json'), 'utf-8');
    const parsed = JSON.parse(files);
    expect(parsed.label).toBe('json-check');
    expect(parsed.cursor).toBe(55);
    expect(parsed.updatedAt).toBeTypeOf('number');
  });

  it('clearCache forces a fresh disk read', () => {
    store.save('cached', 1);
    expect(store.load('cached')).toBe(1);

    store.clearCache();
    // should still load from disk
    expect(store.load('cached')).toBe(1);
  });
});
